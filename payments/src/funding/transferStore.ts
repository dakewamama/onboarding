import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { PostgresMoneyLedger, type MoneyLedger } from "./moneyLedger";

/**
 * Durable custody-transfer records. Postgres in production (alongside Axis
 * Money); files for local development. Every state change after the claim is
 * a compare-and-set so a concurrent status reconcile and an in-progress
 * transfer can never both win.
 */
export interface TransferRecord {
  idempotencyKey: string;
  status: string;
  signature?: string;
  updatedAt: string;
}

export interface TransferStore<T extends TransferRecord> {
  read(key: string): Promise<T | null>;
  /** Insert if absent; otherwise return the existing record untouched. */
  claim(record: T): Promise<{ record: T; inserted: boolean }>;
  /** Write `next` only if the stored record still satisfies `expect`. */
  update(next: T, expect: (current: T) => boolean): Promise<boolean>;
}

export class FileTransferStore<T extends TransferRecord> implements TransferStore<T> {
  constructor(private storeDir: string) {}
  private dir() { return path.join(this.storeDir, "custody-transfers"); }
  private file(key: string) { return path.join(this.dir(), `${createHash("sha256").update(key).digest("hex")}.json`); }
  async read(key: string): Promise<T | null> {
    try { return JSON.parse(fs.readFileSync(this.file(key), "utf8")) as T; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  async claim(record: T): Promise<{ record: T; inserted: boolean }> {
    fs.mkdirSync(this.dir(), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(this.file(record.idempotencyKey), JSON.stringify(record, null, 2), { flag: "wx", mode: 0o600 });
      return { record, inserted: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return { record: (await this.read(record.idempotencyKey))!, inserted: false };
    }
  }
  // Read-check-write is synchronous, so it is atomic within this single process.
  async update(next: T, expect: (current: T) => boolean): Promise<boolean> {
    const target = this.file(next.idempotencyKey);
    const current = JSON.parse(fs.readFileSync(target, "utf8")) as T;
    if (!expect(current)) return false;
    const temp = `${target}.${process.pid}.${process.hrtime.bigint()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(next, null, 2), { flag: "wx", mode: 0o600 });
    fs.renameSync(temp, target);
    return true;
  }
}

export class PostgresTransferStore<T extends TransferRecord> implements TransferStore<T> {
  constructor(private ledger: PostgresMoneyLedger) {}
  async read(key: string): Promise<T | null> {
    await this.ledger.migrate();
    const r = await this.ledger.pool.query("SELECT record FROM custody_transfers WHERE idempotency_key=$1", [key]);
    return (r.rows[0]?.record as T) ?? null;
  }
  async claim(record: T): Promise<{ record: T; inserted: boolean }> {
    await this.ledger.migrate();
    const r = await this.ledger.pool.query(
      "INSERT INTO custody_transfers(idempotency_key,record) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING record",
      [record.idempotencyKey, record]);
    if (r.rows[0]) return { record, inserted: true };
    return { record: (await this.read(record.idempotencyKey))!, inserted: false };
  }
  async update(next: T, expect: (current: T) => boolean): Promise<boolean> {
    await this.ledger.migrate();
    const db = await this.ledger.pool.connect();
    try {
      await db.query("BEGIN");
      const r = await db.query("SELECT record FROM custody_transfers WHERE idempotency_key=$1 FOR UPDATE", [next.idempotencyKey]);
      if (!r.rows[0] || !expect(r.rows[0].record as T)) { await db.query("ROLLBACK"); return false; }
      await db.query("UPDATE custody_transfers SET record=$2, updated_at=now() WHERE idempotency_key=$1", [next.idempotencyKey, next]);
      await db.query("COMMIT");
      return true;
    } catch (error) {
      await db.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      db.release();
    }
  }
}

export function openTransferStore<T extends TransferRecord>(ledger: MoneyLedger, storeDir: string): TransferStore<T> {
  return ledger instanceof PostgresMoneyLedger ? new PostgresTransferStore<T>(ledger) : new FileTransferStore<T>(storeDir);
}

/** One-time import of legacy file transfer records. Safe to re-run. */
export async function importTransferFiles(ledger: PostgresMoneyLedger, storeDir: string): Promise<number> {
  const dir = path.join(storeDir, "custody-transfers");
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith(".json")); } catch { return 0; }
  const store = new PostgresTransferStore<TransferRecord>(ledger);
  let imported = 0;
  for (const f of files) {
    const record = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as TransferRecord;
    if ((await store.claim(record)).inserted) imported++;
  }
  return imported;
}
