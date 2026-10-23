import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { Pool, type PoolClient } from "pg";
import type { CreditRecord } from "./depositLedger";
import { DepositLedger } from "./depositLedger";
import {
  InsufficientBalanceError,
  SpendLedger,
  type SpendRecord,
  type SpendResult,
  type SpendState,
} from "./spendLedger";

/**
 * Axis Money: the single balance authority for custody funds.
 *
 * Production uses PostgresMoneyLedger, a double-entry ledger. Every movement
 * is an immutable transaction whose postings sum to zero, keyed so a replay
 * can never post twice. Per user:
 *
 *   deposit   external        -> user:<o>:available
 *   reserve   user:available  -> user:<o>:held        (spend created)
 *   settle    user:held       -> provider:<p> + axis:pool_gain
 *   release   user:held       -> user:<o>:available   (RELEASED / REVERSED)
 *
 * Available balance is the balance of user:<o>:available. A spend checks and
 * reserves under a per-owner transaction lock, so concurrent spends in any
 * number of processes cannot overdraw.
 *
 * FileMoneyLedger wraps the original JSON-file ledgers for local development
 * and unit tests only; it is single-process and refused in production.
 */
export interface SpendInput {
  owner: string;
  idempotencyKey: string;
  paidBaseUnits: bigint;
  costBaseUnits: bigint;
  reason: string;
  /** Spends with a provider start IN_DOUBT, in the same write as the reserve. */
  provider?: "vtpass" | "custody";
  requestFingerprint?: string;
}

export interface MoneyLedger {
  /** Credit a confirmed deposit once. True only for the call that credited it. */
  credit(record: Omit<CreditRecord, "at">): Promise<boolean>;
  hasCredited(owner: string, signature: string): Promise<boolean>;
  deposits(owner: string): Promise<CreditRecord[]>;
  /** Spendable now: deposits minus every spend that is not released/reversed. */
  availableBaseUnits(owner: string): Promise<bigint>;
  /** Balance-checked, idempotent reserve. Throws InsufficientBalanceError. */
  spend(input: SpendInput): Promise<SpendResult>;
  get(owner: string, key: string): Promise<SpendRecord | null>;
  /** Service-authenticated lookup; ambiguous cross-owner keys fail closed. */
  findByKey(key: string): Promise<SpendRecord | null>;
  /**
   * For a status check on a key with no spend: void the key so a late request
   * carrying it can never debit, and return null. Returns the spend if one exists.
   */
  voidUnknownKey(key: string, reason: string): Promise<SpendRecord | null>;
  /** Terminal states (SETTLED, RELEASED, REVERSED) never change. */
  setState(owner: string, key: string, state: SpendState): Promise<SpendRecord>;
  spentBaseUnits(owner: string): Promise<bigint>;
  poolGainBaseUnits(): Promise<bigint>;
  close(): Promise<void>;
}

export class SpendKeyVoidedError extends Error {
  constructor(readonly key: string) { super(`idempotency key ${key} was voided before any debit`); this.name = "SpendKeyVoidedError"; }
}

const TERMINAL: readonly (SpendState | undefined)[] = ["SETTLED", "RELEASED", "REVERSED"];

export class FileMoneyLedger implements MoneyLedger {
  readonly depositsLedger: DepositLedger;
  readonly spendsLedger: SpendLedger;
  constructor(private dir: string) {
    this.depositsLedger = new DepositLedger(dir);
    this.spendsLedger = new SpendLedger(dir);
  }
  async credit(record: Omit<CreditRecord, "at">) { return this.depositsLedger.credit(record); }
  async hasCredited(owner: string, signature: string) { return this.depositsLedger.hasCredited(owner, signature); }
  async deposits(owner: string) { return this.depositsLedger.deposits(owner); }
  async availableBaseUnits(owner: string) {
    return this.depositsLedger.balanceBaseUnits(owner) - this.spendsLedger.spentBaseUnits(owner);
  }
  private voidedFile(key: string) { return path.join(this.dir, "voided", `${createHash("sha256").update(key).digest("hex")}.json`); }
  async voidUnknownKey(key: string, reason: string) {
    const existing = this.spendsLedger.findByKey(key);
    if (existing) return existing;
    fs.mkdirSync(path.join(this.dir, "voided"), { recursive: true });
    try { fs.writeFileSync(this.voidedFile(key), JSON.stringify({ key, reason, at: new Date().toISOString() }), { flag: "wx" }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return null;
  }
  // Check and write are adjacent and synchronous, so this is safe only within one process.
  async spend(input: SpendInput) {
    if (!this.spendsLedger.get(input.owner, input.idempotencyKey) && fs.existsSync(this.voidedFile(input.idempotencyKey))) throw new SpendKeyVoidedError(input.idempotencyKey);
    return this.spendsLedger.spend(input, this.depositsLedger.balanceBaseUnits(input.owner) - this.spendsLedger.spentBaseUnits(input.owner));
  }
  async get(owner: string, key: string) { return this.spendsLedger.get(owner, key); }
  async findByKey(key: string) { return this.spendsLedger.findByKey(key); }
  async setState(owner: string, key: string, state: SpendState) { return this.spendsLedger.setState(owner, key, state); }
  async spentBaseUnits(owner: string) { return this.spendsLedger.spentBaseUnits(owner); }
  async poolGainBaseUnits() { return this.spendsLedger.poolGainBaseUnits(); }
  async close() {}
}

export const MONEY_SCHEMA = `
CREATE TABLE IF NOT EXISTS money_transactions (
  id bigserial PRIMARY KEY,
  key text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('deposit','reserve','settle','release')),
  owner text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS money_postings (
  transaction_id bigint NOT NULL REFERENCES money_transactions(id),
  account text NOT NULL,
  asset text NOT NULL,
  amount numeric(78,0) NOT NULL CHECK (amount <> 0)
);
CREATE INDEX IF NOT EXISTS money_postings_account ON money_postings (account, asset);
CREATE TABLE IF NOT EXISTS money_deposits (
  owner text NOT NULL,
  signature text NOT NULL,
  base_units numeric(78,0) NOT NULL CHECK (base_units > 0),
  commitment text NOT NULL,
  asset text CHECK (asset IN ('usdc','sol')),
  lamports text,
  price_usdc_per_sol double precision,
  at timestamptz NOT NULL,
  PRIMARY KEY (owner, signature)
);
CREATE TABLE IF NOT EXISTS money_spends (
  owner text NOT NULL,
  idempotency_key text NOT NULL,
  paid numeric(78,0) NOT NULL CHECK (paid > 0),
  cost numeric(78,0) NOT NULL CHECK (cost >= 0 AND cost <= paid),
  reason text NOT NULL,
  state text CHECK (state IN ('IN_DOUBT','PENDING','SETTLED','RELEASED','REVERSED')),
  provider text,
  request_fingerprint text,
  at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, idempotency_key)
);
CREATE INDEX IF NOT EXISTS money_spends_key ON money_spends (idempotency_key);
CREATE TABLE IF NOT EXISTS money_voided_keys (
  idempotency_key text PRIMARY KEY,
  reason text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS custody_transfers (
  idempotency_key text PRIMARY KEY,
  record jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION money_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'money ledger entries are immutable'; END $$;
DROP TRIGGER IF EXISTS money_transactions_immutable ON money_transactions;
CREATE TRIGGER money_transactions_immutable BEFORE UPDATE OR DELETE ON money_transactions FOR EACH ROW EXECUTE FUNCTION money_immutable();
DROP TRIGGER IF EXISTS money_postings_immutable ON money_postings;
CREATE TRIGGER money_postings_immutable BEFORE UPDATE OR DELETE ON money_postings FOR EACH ROW EXECUTE FUNCTION money_immutable();
CREATE OR REPLACE FUNCTION money_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT COALESCE(SUM(amount),0) FROM money_postings WHERE transaction_id = NEW.transaction_id AND asset = NEW.asset) <> 0 THEN
    RAISE EXCEPTION 'unbalanced money transaction %', NEW.transaction_id;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS money_postings_balanced ON money_postings;
CREATE CONSTRAINT TRIGGER money_postings_balanced AFTER INSERT ON money_postings
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION money_balanced();
`;

const ASSET = "USDC";
const available = (owner: string) => `user:${owner}:available`;
const held = (owner: string) => `user:${owner}:held`;

export class PostgresMoneyLedger implements MoneyLedger {
  private ready: Promise<void> | undefined;
  constructor(readonly pool: Pool) {}

  /** Idempotent schema setup; serialized so concurrent boots cannot race. */
  migrate(): Promise<void> {
    this.ready ??= this.tx(async db => {
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('axis-money-schema', 0))");
      await db.query(MONEY_SCHEMA);
    });
    return this.ready;
  }

  private async tx<T>(fn: (db: PoolClient) => Promise<T>): Promise<T> {
    const db = await this.pool.connect();
    try {
      await db.query("BEGIN");
      const out = await fn(db);
      await db.query("COMMIT");
      return out;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
  }

  private async post(db: PoolClient, key: string, kind: string, owner: string, lines: [string, bigint][]): Promise<void> {
    const moving = lines.filter(([, amount]) => amount !== BigInt(0));
    if (moving.reduce((sum, [, amount]) => sum + amount, BigInt(0)) !== BigInt(0)) throw new Error("unbalanced money transaction");
    const inserted = await db.query("INSERT INTO money_transactions(key,kind,owner) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING RETURNING id", [key, kind, owner]);
    if (!inserted.rows[0]) return; // already posted under this identity
    for (const [account, amount] of moving) {
      await db.query("INSERT INTO money_postings(transaction_id,account,asset,amount) VALUES ($1,$2,$3,$4)", [inserted.rows[0].id, account, ASSET, amount.toString()]);
    }
  }

  private async lockOwner(db: PoolClient, owner: string): Promise<void> {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`axis-money:${owner}`]);
  }

  private async lockKey(db: PoolClient, key: string): Promise<void> {
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`axis-money-key:${key}`]);
  }

  async voidUnknownKey(key: string, reason: string): Promise<SpendRecord | null> {
    await this.migrate();
    return this.tx(async db => {
      await this.lockKey(db, key);
      const r = await db.query("SELECT * FROM money_spends WHERE idempotency_key=$1 LIMIT 2", [key]);
      if (r.rows.length > 1) throw new Error("ambiguous action key");
      if (r.rows[0]) return toSpend(r.rows[0]);
      await db.query("INSERT INTO money_voided_keys(idempotency_key,reason) VALUES ($1,$2) ON CONFLICT DO NOTHING", [key, reason]);
      return null;
    });
  }

  private async balance(db: Pool | PoolClient, account: string): Promise<bigint> {
    const r = await db.query("SELECT COALESCE(SUM(amount),0)::text AS v FROM money_postings WHERE account=$1 AND asset=$2", [account, ASSET]);
    return BigInt(r.rows[0].v);
  }

  async credit(record: Omit<CreditRecord, "at">): Promise<boolean> {
    if (BigInt(record.baseUnits) <= BigInt(0)) return false;
    await this.migrate();
    return this.tx(async db => {
      const inserted = await db.query(
        `INSERT INTO money_deposits(owner,signature,base_units,commitment,asset,lamports,price_usdc_per_sol,at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT DO NOTHING RETURNING owner`,
        [record.owner, record.signature, record.baseUnits, record.commitment, record.asset ?? null, record.lamports ?? null, record.priceUsdcPerSol ?? null, new Date().toISOString()],
      );
      if (!inserted.rows[0]) return false;
      const amount = BigInt(record.baseUnits);
      await this.post(db, `deposit:${record.owner}:${record.signature}`, "deposit", record.owner, [["external:deposits", -amount], [available(record.owner), amount]]);
      return true;
    });
  }

  async hasCredited(owner: string, signature: string): Promise<boolean> {
    await this.migrate();
    return !!(await this.pool.query("SELECT 1 FROM money_deposits WHERE owner=$1 AND signature=$2", [owner, signature])).rowCount;
  }

  async deposits(owner: string): Promise<CreditRecord[]> {
    await this.migrate();
    const r = await this.pool.query("SELECT * FROM money_deposits WHERE owner=$1 ORDER BY at DESC", [owner]);
    return r.rows.map(row => ({
      signature: row.signature, owner: row.owner, baseUnits: String(row.base_units), commitment: row.commitment,
      at: new Date(row.at).toISOString(),
      ...(row.asset ? { asset: row.asset } : {}), ...(row.lamports ? { lamports: row.lamports } : {}),
      ...(row.price_usdc_per_sol !== null ? { priceUsdcPerSol: Number(row.price_usdc_per_sol) } : {}),
    }));
  }

  async availableBaseUnits(owner: string): Promise<bigint> {
    await this.migrate();
    return this.balance(this.pool, available(owner));
  }

  async spend(input: SpendInput): Promise<SpendResult> {
    const { owner, idempotencyKey, paidBaseUnits, costBaseUnits } = input;
    if (paidBaseUnits <= BigInt(0)) throw new Error("paid must be positive");
    if (costBaseUnits < BigInt(0)) throw new Error("cost cannot be negative");
    if (costBaseUnits > paidBaseUnits) throw new Error("cost cannot exceed paid");
    await this.migrate();
    return this.tx(async db => {
      await this.lockOwner(db, owner);
      await this.lockKey(db, idempotencyKey);
      const existing = await this.row(db, owner, idempotencyKey);
      if (existing) return { applied: false, duplicate: true, record: existing };
      if ((await db.query("SELECT 1 FROM money_voided_keys WHERE idempotency_key=$1", [idempotencyKey])).rowCount) throw new SpendKeyVoidedError(idempotencyKey);
      const free = await this.balance(db, available(owner));
      if (paidBaseUnits > free) throw new InsufficientBalanceError(owner, paidBaseUnits, free);
      const at = new Date().toISOString();
      const state = input.provider ? "IN_DOUBT" : null;
      await db.query(
        `INSERT INTO money_spends(owner,idempotency_key,paid,cost,reason,state,provider,request_fingerprint,at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [owner, idempotencyKey, paidBaseUnits.toString(), costBaseUnits.toString(), input.reason, state, input.provider ?? null, input.requestFingerprint ?? null, at],
      );
      await this.post(db, `spend:${owner}:${idempotencyKey}:reserve`, "reserve", owner, [[available(owner), -paidBaseUnits], [held(owner), paidBaseUnits]]);
      return { applied: true, duplicate: false, record: (await this.row(db, owner, idempotencyKey))! };
    });
  }

  private async row(db: Pool | PoolClient, owner: string, key: string, lock = false): Promise<SpendRecord | null> {
    const r = await db.query(`SELECT * FROM money_spends WHERE owner=$1 AND idempotency_key=$2${lock ? " FOR UPDATE" : ""}`, [owner, key]);
    return r.rows[0] ? toSpend(r.rows[0]) : null;
  }

  async get(owner: string, key: string): Promise<SpendRecord | null> {
    await this.migrate();
    return this.row(this.pool, owner, key);
  }

  async findByKey(key: string): Promise<SpendRecord | null> {
    await this.migrate();
    const r = await this.pool.query("SELECT * FROM money_spends WHERE idempotency_key=$1 LIMIT 2", [key]);
    if (r.rows.length > 1) throw new Error("ambiguous action key");
    return r.rows[0] ? toSpend(r.rows[0]) : null;
  }

  async setState(owner: string, key: string, state: SpendState): Promise<SpendRecord> {
    await this.migrate();
    return this.tx(async db => {
      const record = await this.row(db, owner, key, true);
      if (!record) throw new Error("unknown spend");
      // A stale pending/unknown reply must never undo a terminal verdict.
      if (TERMINAL.includes(record.state)) return record;
      await db.query("UPDATE money_spends SET state=$3,updated_at=now() WHERE owner=$1 AND idempotency_key=$2", [owner, key, state]);
      const paid = BigInt(record.paidBaseUnits), cost = BigInt(record.costBaseUnits);
      if (state === "SETTLED") {
        await this.post(db, `spend:${owner}:${key}:settle`, "settle", owner, [[held(owner), -paid], [`provider:${record.provider ?? "custody"}`, cost], ["axis:pool_gain", paid - cost]]);
      } else if (state === "RELEASED" || state === "REVERSED") {
        await this.post(db, `spend:${owner}:${key}:release`, "release", owner, [[held(owner), -paid], [available(owner), paid]]);
      }
      return { ...record, state };
    });
  }

  async spentBaseUnits(owner: string): Promise<bigint> {
    await this.migrate();
    const r = await this.pool.query(
      "SELECT COALESCE(SUM(paid),0)::text AS v FROM money_spends WHERE owner=$1 AND (state IS NULL OR state NOT IN ('RELEASED','REVERSED'))", [owner]);
    return BigInt(r.rows[0].v);
  }

  async poolGainBaseUnits(): Promise<bigint> {
    await this.migrate();
    const r = await this.pool.query("SELECT COALESCE(SUM(paid-cost),0)::text AS v FROM money_spends WHERE state IS NULL OR state='SETTLED'");
    return BigInt(r.rows[0].v);
  }

  /**
   * One-time, idempotent import of the legacy JSON-file ledgers. Deposits and
   * spends keep their identities, states and original timestamps (VTpass
   * request ids are derived from a spend's timestamp). Historic spends are
   * imported without a balance check; the report flags any owner left negative.
   */
  async importFileLedger(dir: string): Promise<{ deposits: number; spends: number; negativeOwners: string[] }> {
    await this.migrate();
    const files = new FileMoneyLedger(dir);
    const owners = (sub: string) => { try { return fs.readdirSync(path.join(dir, sub)); } catch { return []; } };
    let deposits = 0, spends = 0;
    for (const folder of owners("credited")) {
      for (const file of fs.readdirSync(path.join(dir, "credited", folder)).filter(f => f.endsWith(".json"))) {
        const d = JSON.parse(fs.readFileSync(path.join(dir, "credited", folder, file), "utf8")) as CreditRecord;
        if (await this.credit(d)) deposits++;
      }
    }
    const touched = new Set<string>();
    for (const folder of owners("spent")) {
      for (const file of fs.readdirSync(path.join(dir, "spent", folder)).filter(f => f.endsWith(".json"))) {
        const r = JSON.parse(fs.readFileSync(path.join(dir, "spent", folder, file), "utf8")) as SpendRecord;
        const record = (await files.get(r.owner, r.idempotencyKey)) ?? r;
        touched.add(record.owner);
        if (await this.importSpend(record)) spends++;
      }
    }
    const negativeOwners: string[] = [];
    for (const owner of touched) if ((await this.availableBaseUnits(owner)) < BigInt(0)) negativeOwners.push(owner);
    return { deposits, spends, negativeOwners };
  }

  private async importSpend(r: SpendRecord): Promise<boolean> {
    const paid = BigInt(r.paidBaseUnits), cost = BigInt(r.costBaseUnits);
    return this.tx(async db => {
      await this.lockOwner(db, r.owner);
      const inserted = await db.query(
        `INSERT INTO money_spends(owner,idempotency_key,paid,cost,reason,state,provider,request_fingerprint,at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING RETURNING owner`,
        [r.owner, r.idempotencyKey, r.paidBaseUnits, r.costBaseUnits, r.reason, r.state ?? null, r.provider ?? null, r.requestFingerprint ?? null, r.at],
      );
      if (!inserted.rows[0]) return false;
      await this.post(db, `spend:${r.owner}:${r.idempotencyKey}:reserve`, "reserve", r.owner, [[available(r.owner), -paid], [held(r.owner), paid]]);
      if (r.state === "SETTLED") await this.post(db, `spend:${r.owner}:${r.idempotencyKey}:settle`, "settle", r.owner, [[held(r.owner), -paid], [`provider:${r.provider ?? "custody"}`, cost], ["axis:pool_gain", paid - cost]]);
      if (r.state === "RELEASED" || r.state === "REVERSED") await this.post(db, `spend:${r.owner}:${r.idempotencyKey}:release`, "release", r.owner, [[held(r.owner), -paid], [available(r.owner), paid]]);
      return true;
    });
  }

  async close(): Promise<void> { await this.pool.end(); }
}

function toSpend(row: Record<string, unknown>): SpendRecord {
  const paid = String(row.paid), cost = String(row.cost);
  return {
    owner: String(row.owner), idempotencyKey: String(row.idempotency_key),
    paidBaseUnits: paid, costBaseUnits: cost, remnantBaseUnits: (BigInt(paid) - BigInt(cost)).toString(),
    reason: String(row.reason), at: new Date(row.at as string).toISOString(),
    ...(row.state ? { state: row.state as SpendState } : {}),
    ...(row.provider ? { provider: row.provider as "vtpass" | "custody" } : {}),
    ...(row.request_fingerprint ? { requestFingerprint: String(row.request_fingerprint) } : {}),
  };
}

const shared = new Map<string, MoneyLedger>();

/**
 * The process-wide ledger. DATABASE_URL selects Postgres. Production refuses
 * to run on the file ledger; local development falls back to it explicitly.
 */
export function openMoneyLedger(env: NodeJS.ProcessEnv, storeDir: string): MoneyLedger {
  const url = env.MONEY_DATABASE_URL ?? env.DATABASE_URL;
  if (!url) {
    if (env.NODE_ENV === "production") throw new Error("DATABASE_URL is required for Axis Money in production");
    const key = `file:${storeDir}`;
    if (!shared.has(key)) shared.set(key, new FileMoneyLedger(storeDir));
    return shared.get(key)!;
  }
  if (!shared.has(url)) shared.set(url, new PostgresMoneyLedger(new Pool({ connectionString: url, max: 10, connectionTimeoutMillis: 5000 })));
  return shared.get(url)!;
}
