import * as fs from "fs";
import * as path from "path";
import type { EncryptedPayload } from "./keyCipher";

/**
 * Storage seam for encrypted key records. The crypto (keyCipher) is fixed; only
 * the backend varies: files for local dev, an in-memory store for tests, and (the
 * next step) Postgres so keys persist on Railway where the container filesystem is
 * ephemeral. `put` is create-once — it must refuse to overwrite an existing user.
 */
export interface EncryptedRecord extends EncryptedPayload {
  publicKey: string;
}

export interface KeyRecordStore {
  has(userId: string): boolean;
  /** Throws if the user is unknown. */
  get(userId: string): EncryptedRecord;
  /** Create-once: throws if the user already exists. */
  put(userId: string, record: EncryptedRecord): void;
}

export class InMemoryKeyRecordStore implements KeyRecordStore {
  private map = new Map<string, EncryptedRecord>();
  has(userId: string): boolean {
    return this.map.has(userId);
  }
  get(userId: string): EncryptedRecord {
    const rec = this.map.get(userId);
    if (!rec) throw new Error(`unknown user ${userId}`);
    return rec;
  }
  put(userId: string, record: EncryptedRecord): void {
    if (this.map.has(userId)) throw new Error(`user ${userId} already exists`);
    this.map.set(userId, record);
  }
}

export class FileKeyRecordStore implements KeyRecordStore {
  constructor(private dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }
  private p(userId: string): string {
    return path.join(this.dir, `${userId}.json`);
  }
  has(userId: string): boolean {
    return fs.existsSync(this.p(userId));
  }
  get(userId: string): EncryptedRecord {
    if (!this.has(userId)) throw new Error(`unknown user ${userId}`);
    return JSON.parse(fs.readFileSync(this.p(userId), "utf8")) as EncryptedRecord;
  }
  put(userId: string, record: EncryptedRecord): void {
    // `wx` makes create-once atomic — two racing creates can't both win.
    fs.writeFileSync(this.p(userId), JSON.stringify(record, null, 2), {
      flag: "wx",
      mode: 0o600,
    });
  }
}
