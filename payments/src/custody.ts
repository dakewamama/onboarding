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
 * NOTE (consolidation debt): server/src/keyCipher holds the same crypto, but
 * server/ is NOT deployed (the Railway image builds only payments/). This is the
 * production custody home; the two should be unified once custody consolidates
 * into one deployed service. Records live under the funding store dir, so they
 * persist on the same Railway Volume as the ledgers (mount /data before mainnet).
 */

interface WalletRecord {
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

function walletPath(storeDir: string, userId: string): string {
  return path.join(walletsDir(storeDir), `${safe(userId)}.json`);
}

export function walletAddressFor(storeDir: string, userId: string): string | null {
  const p = walletPath(storeDir, userId);
  if (!fs.existsSync(p)) return null;
  return (JSON.parse(fs.readFileSync(p, "utf8")) as WalletRecord).publicKey;
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
  const p = walletPath(storeDir, userId);
  if (!fs.existsSync(p)) throw new Error(`no wallet for ${userId}`);
  const rec = JSON.parse(fs.readFileSync(p, "utf8")) as WalletRecord;
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

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}
