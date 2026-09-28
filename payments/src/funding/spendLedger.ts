import * as fs from "fs";
import * as path from "path";
import { createHash, randomUUID } from "crypto";

export type SpendState = "IN_DOUBT" | "PENDING" | "SETTLED" | "RELEASED" | "REVERSED";

/**
 * Durable, restart-safe ledger of SPENDS (debits) — the missing debit path.
 *
 * Mirrors DepositLedger's contract exactly: one atomic file per idempotency key,
 * created with the `wx` flag, so a crash can neither miss a debit nor double-
 * charge. A user's available balance is DERIVED: credited deposits minus recorded
 * spends, so it can never drift.
 *
 * Each spend also carries the money model: the user is charged `paid`, the
 * provider costs `cost`, and the `remnant = paid - cost` is booked as pool gain
 * for Axis. Pool gain is DERIVED by summing remnants, never a mutable counter.
 *
 * A real deployment swaps the files for a table with a UNIQUE constraint on the
 * idempotency key and does the balance check + insert in one transaction (which
 * also closes the check-then-write race noted below). The `.funding-store/`
 * directory is gitignored — money is never committed.
 */

export interface SpendRecord {
  /** The Axis wallet / user this is charged to. */
  owner: string;
  /** Caller-supplied idempotency key (e.g. the purchase request id). */
  idempotencyKey: string;
  /** Charged to the user, integer base units (6 dp), as a string. */
  paidBaseUnits: string;
  /** Provider cost (e.g. VTpass), integer base units. 0 <= cost <= paid. */
  costBaseUnits: string;
  /** paid - cost, booked as pool gain for Axis. */
  remnantBaseUnits: string;
  reason: string;
  at: string;
  state?: SpendState;
  provider?: "vtpass";
  requestFingerprint?: string;
}

export class InsufficientBalanceError extends Error {
  constructor(
    readonly owner: string,
    readonly requestedBaseUnits: bigint,
    readonly availableBaseUnits: bigint,
  ) {
    super(
      `insufficient balance for ${owner}: need ${requestedBaseUnits}, have ${availableBaseUnits}`,
    );
    this.name = "InsufficientBalanceError";
  }
}

export interface SpendResult {
  /** True if THIS call recorded the debit. */
  applied: boolean;
  /** True if the idempotency key was already recorded (a safe replay). */
  duplicate: boolean;
  record: SpendRecord;
}

export class SpendLedger {
  constructor(private dir: string) {
    fs.mkdirSync(path.join(dir, "spent"), { recursive: true });
  }

  private ownerDir(owner: string): string {
    return path.join(this.dir, "spent", safe(owner));
  }

  private spendPath(owner: string, key: string): string {
    return path.join(this.ownerDir(owner), `${createHash("sha256").update(key).digest("hex")}.json`);
  }

  hasSpent(owner: string, idempotencyKey: string): boolean {
    const record = this.get(owner, idempotencyKey);
    return record !== null && record.state !== "RELEASED" && record.state !== "REVERSED";
  }

  private existingPath(owner: string, key: string): string {
    const current = this.spendPath(owner, key);
    if (fs.existsSync(current)) return current;
    return path.join(this.ownerDir(owner), `${safe(key)}.json`); // legacy store
  }

  get(owner: string, key: string): SpendRecord | null {
    try {
      const record = JSON.parse(fs.readFileSync(this.existingPath(owner, key), "utf8")) as SpendRecord;
      if (record.owner !== owner || record.idempotencyKey !== key) throw new Error("spend identity collision");
      return record;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err; // corrupt accounting must fail closed
    }
  }

  /** Service-authenticated status lookup. Ambiguous cross-owner keys fail closed. */
  findByKey(key: string): SpendRecord | null {
    const records = fs.readdirSync(path.join(this.dir, "spent"))
      .flatMap(owner => this.recordsInDir(path.join(this.dir, "spent", owner)))
      .filter(record => record.idempotencyKey === key);
    if (records.length > 1) throw new Error("ambiguous action key");
    return records[0] ?? null;
  }

  setState(owner: string, key: string, state: SpendState): SpendRecord {
    const record = this.get(owner, key);
    if (!record) throw new Error("unknown spend");
    // A stale pending/unknown reply must never undo a terminal verdict.
    if (["SETTLED", "RELEASED", "REVERSED"].includes(record.state ?? "")) return record;
    const updated = { ...record, state };
    const target = this.existingPath(owner, key);
    const temp = `${target}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(updated, null, 2), { flag: "wx" });
    fs.renameSync(temp, target);
    return updated;
  }

  /**
   * Atomically debit `paid` from the owner. `availableBaseUnits` is the owner's
   * current available balance (deposits - already spent), supplied by the caller.
   * Idempotent on `idempotencyKey`: a replay returns the existing record and does
   * NOT debit again. Throws InsufficientBalanceError when paid > available.
   */
  spend(
    input: {
      owner: string;
      idempotencyKey: string;
      paidBaseUnits: bigint;
      costBaseUnits: bigint;
      reason: string;
      provider?: "vtpass";
      requestFingerprint?: string;
    },
    availableBaseUnits: bigint,
  ): SpendResult {
    const { owner, idempotencyKey, paidBaseUnits, costBaseUnits, reason } = input;

    if (paidBaseUnits <= BigInt(0)) throw new Error("paid must be positive");
    if (costBaseUnits < BigInt(0)) throw new Error("cost cannot be negative");
    if (costBaseUnits > paidBaseUnits) throw new Error("cost cannot exceed paid");

    const existing = this.get(owner, idempotencyKey);
    if (existing) return { applied: false, duplicate: true, record: existing };

    if (paidBaseUnits > availableBaseUnits) {
      throw new InsufficientBalanceError(owner, paidBaseUnits, availableBaseUnits);
    }

    const record: SpendRecord = {
      owner,
      idempotencyKey,
      paidBaseUnits: paidBaseUnits.toString(),
      costBaseUnits: costBaseUnits.toString(),
      remnantBaseUnits: (paidBaseUnits - costBaseUnits).toString(),
      reason,
      at: new Date().toISOString(),
      ...(input.provider ? { provider: input.provider, requestFingerprint: input.requestFingerprint, state: "IN_DOUBT" as const } : {}),
    };
    fs.mkdirSync(this.ownerDir(owner), { recursive: true });
    try {
      fs.writeFileSync(
        this.spendPath(owner, idempotencyKey),
        JSON.stringify(record, null, 2),
        { flag: "wx" },
      );
      return { applied: true, duplicate: false, record };
    } catch (err) {
      // Lost a race to an identical key: treat as a duplicate, never double-charge.
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return {
          applied: false,
          duplicate: true,
          record: this.get(owner, idempotencyKey) ?? record,
        };
      }
      throw err;
    }
  }

  /** Total charged to an owner (sum of paid), integer base units. */
  spentBaseUnits(owner: string): bigint {
    return this.records(owner).filter(r => r.state !== "RELEASED" && r.state !== "REVERSED").reduce(
      (sum, r) => sum + BigInt(r.paidBaseUnits),
      BigInt(0),
    );
  }

  /** Total pool gain across all owners (sum of remnants), integer base units. */
  poolGainBaseUnits(): bigint {
    const spentRoot = path.join(this.dir, "spent");
    if (!fs.existsSync(spentRoot)) return BigInt(0);
    let total = BigInt(0);
    for (const owner of fs.readdirSync(spentRoot)) {
      for (const r of this.recordsInDir(path.join(spentRoot, owner))) {
        if (r.state === undefined || r.state === "SETTLED") total += BigInt(r.remnantBaseUnits);
      }
    }
    return total;
  }

  records(owner: string): SpendRecord[] {
    return this.recordsInDir(this.ownerDir(owner));
  }

  private recordsInDir(dir: string): SpendRecord[] {
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as SpendRecord)
      .sort((a, b) => b.at.localeCompare(a.at));
  }
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}
