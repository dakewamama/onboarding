import * as fs from "fs";
import * as path from "path";

/**
 * Local persistence for two things v2 makes us handle ourselves:
 *   1. orderReference <-> pajId correlation — Paj has no metadata/reference field,
 *      so the only link between your order and Paj's is the id it returns.
 *   2. Idempotent settlement — duplicate webhooks must credit exactly once.
 *
 * A real deployment uses a database with a UNIQUE constraint on pajId; this file
 * store mirrors that contract (settlement uses an atomic create, `wx`). The
 * `.paj-store/` directory is gitignored.
 */
export class PaymentStore {
  constructor(private dir: string) {
    fs.mkdirSync(path.join(dir, "orders"), { recursive: true });
    fs.mkdirSync(path.join(dir, "settled"), { recursive: true });
  }

  private orderPath(ref: string): string {
    return path.join(this.dir, "orders", `ref_${safe(ref)}.json`);
  }
  private pajPath(pajId: string): string {
    return path.join(this.dir, "orders", `paj_${safe(pajId)}.json`);
  }
  private settledPath(pajId: string): string {
    return path.join(this.dir, "settled", `${safe(pajId)}.json`);
  }

  link(orderReference: string, pajId: string): void {
    const rec = { orderReference, pajId, at: new Date().toISOString() };
    fs.writeFileSync(this.orderPath(orderReference), JSON.stringify(rec, null, 2));
    fs.writeFileSync(this.pajPath(pajId), JSON.stringify(rec, null, 2));
  }

  pajIdFor(orderReference: string): string | null {
    const p = this.orderPath(orderReference);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).pajId : null;
  }

  orderReferenceFor(pajId: string): string | null {
    const p = this.pajPath(pajId);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")).orderReference : null;
  }

  isSettled(pajId: string): boolean {
    return fs.existsSync(this.settledPath(pajId));
  }

  /** Atomic. Returns true if this call settled it, false if already settled. */
  markSettled(pajId: string, data: unknown): boolean {
    try {
      fs.writeFileSync(
        this.settledPath(pajId),
        JSON.stringify({ at: new Date().toISOString(), data }, null, 2),
        { flag: "wx" }
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw err;
    }
  }
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}
