import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Keypair } from "@solana/web3.js";
import { KEYSTORE_DIR } from "./config";

/**
 * DEVNET PROTOTYPE ONLY — models a custodial key store with envelope encryption:
 * a single master key wraps each per-user secret key (AES-256-GCM).
 *
 * In production the master key is a non-exportable CMK inside a KMS/HSM (AWS KMS,
 * GCP KMS, Turnkey, ...), signing happens inside that boundary, and this
 * local-file storage does not exist. Never point this at mainnet keys or real
 * funds. The `.keystore/` directory is gitignored.
 */

const USERS_DIR = path.join(KEYSTORE_DIR, "users");
const MASTER_KEY_PATH = path.join(KEYSTORE_DIR, "master.key");

interface EncryptedRecord {
  publicKey: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

function loadMasterKey(): Buffer {
  fs.mkdirSync(USERS_DIR, { recursive: true });
  if (process.env.KEYSTORE_MASTER_KEY) {
    return Buffer.from(process.env.KEYSTORE_MASTER_KEY, "hex");
  }
  if (!fs.existsSync(MASTER_KEY_PATH)) {
    fs.writeFileSync(MASTER_KEY_PATH, crypto.randomBytes(32).toString("hex"), {
      mode: 0o600,
    });
    console.warn(
      "[keystore] generated a local master key — devnet stand-in for a KMS CMK"
    );
  }
  return Buffer.from(fs.readFileSync(MASTER_KEY_PATH, "utf8").trim(), "hex");
}

function encrypt(plaintext: Buffer): Omit<EncryptedRecord, "publicKey"> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadMasterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
}

function decrypt(rec: EncryptedRecord): Buffer {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    loadMasterKey(),
    Buffer.from(rec.iv, "hex")
  );
  decipher.setAuthTag(Buffer.from(rec.tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(rec.ciphertext, "hex")),
    decipher.final(),
  ]);
}

function recordPath(userId: string): string {
  return path.join(USERS_DIR, `${userId}.json`);
}

function readRecord(userId: string): EncryptedRecord {
  const file = recordPath(userId);
  if (!fs.existsSync(file)) throw new Error(`unknown user ${userId}`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/** Generate and store a fresh custodial keypair for a user. Returns the pubkey. */
export function createUserKey(userId: string): string {
  fs.mkdirSync(USERS_DIR, { recursive: true });
  if (fs.existsSync(recordPath(userId))) {
    throw new Error(`user ${userId} already exists`);
  }
  const kp = Keypair.generate();
  const record: EncryptedRecord = {
    publicKey: kp.publicKey.toBase58(),
    ...encrypt(Buffer.from(kp.secretKey)),
  };
  fs.writeFileSync(recordPath(userId), JSON.stringify(record, null, 2), {
    mode: 0o600,
  });
  return record.publicKey;
}

export function getUserPublicKey(userId: string): string {
  return readRecord(userId).publicKey;
}

export function userExists(userId: string): boolean {
  return fs.existsSync(recordPath(userId));
}

/**
 * Decrypts the user's key only for the duration of `fn` (a signing call), then
 * zeroes the plaintext. `fn` is awaited so the key stays live until signing
 * completes.
 */
export async function withUserKeypair<T>(
  userId: string,
  fn: (kp: Keypair) => Promise<T>
): Promise<T> {
  const secret = decrypt(readRecord(userId));
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
  try {
    return await fn(kp);
  } finally {
    secret.fill(0);
  }
}
