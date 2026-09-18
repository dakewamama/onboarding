import * as crypto from "crypto";

/**
 * Envelope encryption primitives (AES-256-GCM), pure and testable. A single
 * master key wraps each secret key. Kept separate from storage so the same crypto
 * is reused whether records live in files, in Postgres, or (eventually) a KMS.
 *
 * The master key here is a raw 32-byte key. In production it should be a
 * non-exportable CMK inside a KMS/HSM and the wrap/unwrap should happen there;
 * this module is the local stand-in with the identical record shape.
 */

export interface EncryptedPayload {
  iv: string; // hex, 12 bytes
  tag: string; // hex, GCM auth tag
  ciphertext: string; // hex
}

function assertKey(masterKey: Buffer): void {
  if (masterKey.length !== 32) {
    throw new Error("master key must be 32 bytes (AES-256)");
  }
}

export function encryptSecret(plaintext: Buffer, masterKey: Buffer): EncryptedPayload {
  assertKey(masterKey);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    iv: iv.toString("hex"),
    tag: cipher.getAuthTag().toString("hex"),
    ciphertext: ciphertext.toString("hex"),
  };
}

/** Decrypt; throws if the master key is wrong or the ciphertext/tag was tampered
 *  (GCM authentication), so a corrupted or forged record can never yield a key. */
export function decryptSecret(payload: EncryptedPayload, masterKey: Buffer): Buffer {
  assertKey(masterKey);
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    masterKey,
    Buffer.from(payload.iv, "hex"),
  );
  decipher.setAuthTag(Buffer.from(payload.tag, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(payload.ciphertext, "hex")),
    decipher.final(),
  ]);
}
