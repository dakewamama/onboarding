import * as fs from "fs";
import * as path from "path";

/**
 * The one identity map: brain `userId` <-> the user's custodial wallet address.
 *
 * This is the fix for the money-key mismatch: deposits are credited by wallet
 * ADDRESS (the watcher watches an on-chain address), but the brain speaks in
 * `userId`. Everything money-related keys off the wallet address; this map lets
 * the airtime/debit edge translate a userId to that single canonical key so a
 * balance actually reconciles (deposits and spends land under the same owner).
 *
 * Custodial model: the address is the user's Axis-held wallet. The link is
 * create-once and idempotent — re-linking the same pair is fine, but a userId can
 * never be silently repointed to a different wallet (that would strand a balance).
 * File-backed for now; a Postgres table with UNIQUE(userId), UNIQUE(address) is
 * the durable swap (same contract).
 */
export class IdentityStore {
  private byUser: string;
  private byAddress: string;

  constructor(dir: string) {
    this.byUser = path.join(dir, "identity", "by-user");
    this.byAddress = path.join(dir, "identity", "by-address");
    fs.mkdirSync(this.byUser, { recursive: true });
    fs.mkdirSync(this.byAddress, { recursive: true });
  }

  private userFile(userId: string): string {
    return path.join(this.byUser, `${safe(userId)}.txt`);
  }
  private addressFile(address: string): string {
    return path.join(this.byAddress, `${safe(address)}.txt`);
  }

  /** Map a userId to its custodial wallet address. Idempotent; throws on a
   *  conflicting remap (userId already points at a different address). */
  link(userId: string, address: string): void {
    if (!userId || !address) throw new Error("userId and address are required");
    const existing = this.addressFor(userId);
    if (existing && existing !== address) {
      throw new Error(`userId ${userId} is already linked to a different wallet`);
    }
    fs.writeFileSync(this.userFile(userId), address);
    fs.writeFileSync(this.addressFile(address), userId);
  }

  addressFor(userId: string): string | null {
    const f = this.userFile(userId);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : null;
  }

  userFor(address: string): string | null {
    const f = this.addressFile(address);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : null;
  }
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}
