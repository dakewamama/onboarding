import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

/**
 * The one identity map: brain `userId` <-> the user's custodial wallet address.
 *
 * This is the fix for the money-key mismatch: deposits are credited by wallet
 * ADDRESS (the watcher watches an on-chain address), but the brain speaks in
 * `userId`. Everything money-related keys off the wallet address; this map lets
 * the airtime/debit edge translate a userId to that single canonical key so a
 * balance actually reconciles (deposits and spends land under the same owner).
 *
 * The link is create-once and idempotent: re-linking the same pair is fine, but
 * neither side can be repointed. A userId never moves to another wallet (that
 * would strand a balance) and an address never gains a second user (that would
 * let two users spend one balance).
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

  /** Collision-free file per exact userId. */
  private userFile(userId: string): string {
    return path.join(this.byUser, `u_${crypto.createHash("sha256").update(userId).digest("hex")}.txt`);
  }
  /** Pre-hash name, which ids differing only in punctuation could share. */
  private legacyUserFile(userId: string): string {
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
    const owner = this.userFor(address);
    if (owner !== null && owner !== userId) throw new Error("address is already linked to a different user");
    fs.writeFileSync(this.userFile(userId), address);
    fs.writeFileSync(this.addressFile(address), userId);
  }

  addressFor(userId: string): string | null {
    const f = this.userFile(userId);
    if (fs.existsSync(f)) return fs.readFileSync(f, "utf8").trim();
    // A legacy link counts only when its address records exactly this userId.
    const legacy = this.legacyUserFile(userId);
    if (!fs.existsSync(legacy)) return null;
    const address = fs.readFileSync(legacy, "utf8").trim();
    if (this.userFor(address) !== userId) return null;
    fs.writeFileSync(f, address);
    return address;
  }

  userFor(address: string): string | null {
    const f = this.addressFile(address);
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : null;
  }
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}
