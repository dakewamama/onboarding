import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Keypair } from "@solana/web3.js";

/**
 * Per-user custodial wallet, IN THE DEPLOYED payments service. This is what gives
 * each user a distinct on-chain deposit address so deposits can be attributed to
 * them (the watcher credits by address; identity maps userId <-> that address).
 *
 * Envelope encryption: a Solana secret key wrapped with AES-256-GCM under
 * KEYSTORE_MASTER_KEY (32 bytes / 64 hex). Fail-closed: no master key => throws.
 *
 * Records live under the funding store dir, on the same volume as the ledgers
 * (mount /data in production, or keys are lost on redeploy).
 */

interface WalletRecord {
  /** The exact owner. Absent only in records written before owners were recorded. */
  userId?: string;
  publicKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function masterKey(env: NodeJS.ProcessEnv): Buffer {
  const hex = env.KEYSTORE_MASTER_KEY;
  if (!hex) throw new Error("KEYSTORE_MASTER_KEY not set");
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error("KEYSTORE_MASTER_KEY must be 32 bytes (64 hex chars)");
  }
  return key;
}

function walletsDir(storeDir: string): string {
  return path.join(storeDir, "wallets");
}

/** Collision-free file per exact userId ("web:1" and "web_1" are different users). */
function walletPath(storeDir: string, userId: string): string {
  return path.join(walletsDir(storeDir), `u_${crypto.createHash("sha256").update(userId).digest("hex")}.json`);
}

/** Pre-hash file name, which could be shared by ids that differ only in punctuation. */
function legacyWalletPath(storeDir: string, userId: string): string {
  return path.join(walletsDir(storeDir), `${userId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
}

/**
 * The user's wallet record, or null. A legacy record is claimed by the first
 * exact userId that reads it: copied to that user's own file with its owner
 * recorded, the old file kept as `.migrated`. Any other id mapping to the same
 * legacy file is refused, so two users can never share keys.
 */
function loadWallet(storeDir: string, userId: string): WalletRecord | null {
  const own = walletPath(storeDir, userId);
  if (fs.existsSync(own)) {
    const rec = JSON.parse(fs.readFileSync(own, "utf8")) as WalletRecord;
    if (rec.userId !== userId) throw new Error("wallet owner mismatch");
    return rec;
  }
  const legacy = legacyWalletPath(storeDir, userId);
  if (!fs.existsSync(legacy)) return null;
  const rec = JSON.parse(fs.readFileSync(legacy, "utf8")) as WalletRecord;
  if (rec.userId !== undefined && rec.userId !== userId) throw new Error("wallet belongs to another user");
  const claimed: WalletRecord = { ...rec, userId };
  fs.writeFileSync(own, JSON.stringify(claimed, null, 2), { flag: "wx", mode: 0o600 });
  fs.renameSync(legacy, `${legacy}.migrated`);
  return claimed;
}

export function walletAddressFor(storeDir: string, userId: string): string | null {
  return loadWallet(storeDir, userId)?.publicKey ?? null;
}

/** Create (idempotently) a custodial wallet for a user and return its address.
 *  `created` is false when the user already had one. */
export function provisionWallet(
  storeDir: string,
  userId: string,
  env: NodeJS.ProcessEnv = process.env,
): { userId: string; address: string; created: boolean } {
  fs.mkdirSync(walletsDir(storeDir), { recursive: true });
  const existing = walletAddressFor(storeDir, userId);
  if (existing) return { userId, address: existing, created: false };

  const kp = Keypair.generate();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(env), iv);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(kp.secretKey)),
    cipher.final(),
  ]);
  const record: WalletRecord = {
    userId,
    publicKey: kp.publicKey.toBase58(),
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
  fs.writeFileSync(walletPath(storeDir, userId), JSON.stringify(record, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return { userId, address: record.publicKey, created: true };
}

/** Decrypt the user's keypair for the duration of `fn` (a signing call), then zero
 *  the plaintext. Used by the payout signer (off-ramp), never for airtime. */
export async function withUserKeypair<T>(
  storeDir: string,
  userId: string,
  fn: (kp: Keypair) => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  const rec = loadWallet(storeDir, userId);
  if (!rec) throw new Error(`no wallet for ${userId}`);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    masterKey(env),
    Buffer.from(rec.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(rec.tag, "hex"));
  const secret = Buffer.concat([
    decipher.update(Buffer.from(rec.ciphertext, "hex")),
    decipher.final(),
  ]);
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  try {
    return await fn(kp);
  } finally {
    secret.fill(0);
  }
}
