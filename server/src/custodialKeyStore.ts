import { Keypair } from "@solana/web3.js";
import { encryptSecret, decryptSecret } from "./keyCipher";
import type { EncryptedRecord, KeyRecordStore } from "./keyRecordStore";

/**
 * The custodial key store, decoupled from storage. Given a record backend and a
 * master-key source, it creates per-user keypairs (envelope-encrypted) and lends
 * a decrypted keypair only for the duration of a signing call, zeroing it after.
 * Swap the backend (file / in-memory / Postgres) without touching this logic.
 */
export interface KeyStore {
  createUserKey(userId: string): string;
  getUserPublicKey(userId: string): string;
  userExists(userId: string): boolean;
  withUserKeypair<T>(userId: string, fn: (kp: Keypair) => Promise<T>): Promise<T>;
}

export function makeKeyStore(
  store: KeyRecordStore,
  getMasterKey: () => Buffer,
): KeyStore {
  return {
    createUserKey(userId: string): string {
      if (store.has(userId)) throw new Error(`user ${userId} already exists`);
      const kp = Keypair.generate();
      const enc = encryptSecret(Buffer.from(kp.secretKey), getMasterKey());
      const record: EncryptedRecord = { publicKey: kp.publicKey.toBase58(), ...enc };
      store.put(userId, record);
      return record.publicKey;
    },
    getUserPublicKey(userId: string): string {
      return store.get(userId).publicKey;
    },
    userExists(userId: string): boolean {
      return store.has(userId);
    },
    async withUserKeypair<T>(
      userId: string,
      fn: (kp: Keypair) => Promise<T>,
    ): Promise<T> {
      const secret = decryptSecret(store.get(userId), getMasterKey());
      const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
      try {
        return await fn(kp);
      } finally {
        secret.fill(0);
      }
    },
  };
}
