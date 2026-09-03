import * as fs from "fs";
import * as path from "path";

/**
 * Durable, restart-safe ledger of on-chain USDC deposits.
 *
 * The single source of truth is one atomic file per transaction signature,
 * created with the `wx` flag — exactly the idempotency contract PaymentStore uses
 * for Paj settlements (src/store.ts). Claiming a signature and crediting it is ONE
 * atomic filesystem operation, so a crash can neither miss a credited deposit nor
 * double-credit it. Balance is DERIVED by summing an owner's credited records, so
 * it can never drift from the underlying deposits.
 *
 * A real deployment swaps this for a table with a UNIQUE constraint on the
 * signature; the contract is identical. The `.funding-store/` directory is
 * gitignored — deposits are money, never committed.
 */

export interface CreditRecord {
  /** Solana transaction signature — the idempotency key. */
  signature: string;
  /** The Axis wallet (owner) that received the USDC. */
  owner: string;
  /** Integer USDC base units (6 dp). Stored as a string; never a float. */
  baseUnits: string;
  /** RPC commitment the deposit had reached when credited. */
  commitment: string;
  at: string;
}

export class DepositLedger {
  constructor(private dir: string) {
    fs.mkdirSync(path.join(dir, "credited"), { recursive: true });
  }

  private ownerDir(owner: string): string {
    return path.join(this.dir, "credited", safe(owner));
  }

  private creditPath(owner: string, signature: string): string {
    return path.join(this.ownerDir(owner), `${safe(signature)}.json`);
  }

  /** True if this signature has already been credited to this owner. */
  hasCredited(owner: string, signature: string): boolean {
    return fs.existsSync(this.creditPath(owner, signature));
  }

  /**
   * Atomically record a deposit. Returns true if THIS call credited it, false if
   * it was already credited (a duplicate the watcher re-observed). Credit the
   * balance exactly when this returns true — never on any other signal.
   */
  credit(record: Omit<CreditRecord, "at">): boolean {
    if (BigInt(record.baseUnits) <= BigInt(0)) return false;
    fs.mkdirSync(this.ownerDir(record.owner), { recursive: true });
    const full: CreditRecord = { ...record, at: new Date().toISOString() };
    try {
      fs.writeFileSync(
        this.creditPath(record.owner, record.signature),
        JSON.stringify(full, null, 2),
        { flag: "wx" }
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }

  /** Sum of all credited deposits for an owner, in integer base units. */
  balanceBaseUnits(owner: string): bigint {
    const dir = this.ownerDir(owner);
    if (!fs.existsSync(dir)) return BigInt(0);
    let total = BigInt(0);
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const rec = JSON.parse(
        fs.readFileSync(path.join(dir, file), "utf8")
      ) as CreditRecord;
      total += BigInt(rec.baseUnits);
    }
    return total;
  }

  /** All credited deposits for an owner, newest first. */
  deposits(owner: string): CreditRecord[] {
    const dir = this.ownerDir(owner);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")))
      .sort((a: CreditRecord, b: CreditRecord) => b.at.localeCompare(a.at));
  }
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}
