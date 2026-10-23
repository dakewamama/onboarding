import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { Keypair, PublicKey } from "@solana/web3.js";
import type { Pool } from "pg";
import { provisionWallet as provisionFileWallet, walletAddressFor as fileWalletAddress, withUserKeypair as fileWithKeypair } from "./custody";
import { IdentityStore } from "./identity";
import { PostgresMoneyLedger, type MoneyLedger } from "./funding/moneyLedger";

/**
 * Each user's wallet: an Axis custodial wallet (address + encrypted key) or an
 * externally held wallet they linked. One record per user and per address, so a
 * user's balance, airtime and custody transfers all use the same wallet, and two
 * users can never share one.
 *
 * Production keeps these in Postgres beside Axis Money, so a redeploy without a
 * volume cannot lose wallet keys. Keys are wrapped with AES-256-GCM under
 * KEYSTORE_MASTER_KEY; the plaintext exists only while a signature is made.
 * Local development without a database uses the original files.
 */
export interface WalletAccounts {
  /** The user's wallet address (custodial or linked), or null. */
  addressFor(userId: string): Promise<string | null>;
  userFor(address: string): Promise<string | null>;
  /** The user's custodial wallet address only, or null. */
  custodialAddress(userId: string): Promise<string | null>;
  /** Create the user's custodial wallet once; later calls return it. */
  provision(userId: string): Promise<{ userId: string; address: string; created: boolean }>;
  /** Link an externally held wallet. Refused when the user has another wallet or the address belongs to someone else. */
  linkExternal(userId: string, address: string): Promise<void>;
  /** Decrypt the user's custodial key for the duration of `fn`, then zero it. */
  withKeypair<T>(userId: string, fn: (kp: Keypair) => Promise<T>): Promise<T>;
}

export class WalletConflict extends Error {}

function masterKey(env: NodeJS.ProcessEnv): Buffer {
  const hex = env.KEYSTORE_MASTER_KEY;
  if (!hex) throw new Error("KEYSTORE_MASTER_KEY not set");
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) throw new Error("KEYSTORE_MASTER_KEY must be 32 bytes (64 hex chars)");
  return key;
}

export const ACCOUNTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS wallet_accounts (
  user_id text PRIMARY KEY,
  address text NOT NULL UNIQUE,
  custodial boolean NOT NULL,
  iv text, tag text, ciphertext text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (custodial = (ciphertext IS NOT NULL AND iv IS NOT NULL AND tag IS NOT NULL))
);`;

export class PostgresWalletAccounts implements WalletAccounts {
  private ready: Promise<void> | undefined;
  constructor(private pool: Pool, private env: NodeJS.ProcessEnv = process.env) {}

  migrate(): Promise<void> {
    this.ready ??= (async () => {
      const db = await this.pool.connect();
      try {
        await db.query("BEGIN");
        await db.query("SELECT pg_advisory_xact_lock(hashtextextended('axis-accounts-schema', 0))");
        await db.query(ACCOUNTS_SCHEMA);
        await db.query("COMMIT");
      } catch (error) {
        await db.query("ROLLBACK");
        throw error;
      } finally {
        db.release();
      }
    })();
    return this.ready;
  }

  private async row(userId: string) {
    await this.migrate();
    return (await this.pool.query("SELECT * FROM wallet_accounts WHERE user_id=$1", [userId])).rows[0];
  }

  async addressFor(userId: string) {
    return (await this.row(userId))?.address ?? null;
  }

  async userFor(address: string) {
    await this.migrate();
    return (await this.pool.query("SELECT user_id FROM wallet_accounts WHERE address=$1", [address])).rows[0]?.user_id ?? null;
  }

  async custodialAddress(userId: string) {
    const r = await this.row(userId);
    return r?.custodial ? String(r.address) : null;
  }

  async provision(userId: string): Promise<{ userId: string; address: string; created: boolean }> {
    if (!userId) throw new Error("userId is required");
    const existing = await this.row(userId);
    if (existing) {
      if (!existing.custodial) throw new WalletConflict("user already linked an external wallet");
      return { userId, address: String(existing.address), created: false };
    }
    const kp = Keypair.generate();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(this.env), iv);
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(kp.secretKey)), cipher.final()]);
    const address = kp.publicKey.toBase58();
    const inserted = await this.pool.query(
      `INSERT INTO wallet_accounts(user_id,address,custodial,iv,tag,ciphertext) VALUES ($1,$2,true,$3,$4,$5) ON CONFLICT (user_id) DO NOTHING RETURNING address`,
      [userId, address, iv.toString("hex"), cipher.getAuthTag().toString("hex"), ciphertext.toString("hex")],
    );
    kp.secretKey.fill(0);
    if (inserted.rowCount) return { userId, address, created: true };
    // A concurrent call created it first: report that wallet.
    return this.provision(userId);
  }

  async linkExternal(userId: string, address: string) {
    new PublicKey(address);
    await this.migrate();
    const r = await this.pool.query(
      `INSERT INTO wallet_accounts(user_id,address,custodial) VALUES ($1,$2,false) ON CONFLICT DO NOTHING RETURNING user_id`,
      [userId, address],
    );
    if (r.rowCount) return;
    const mine = await this.row(userId);
    if (mine?.address === address) return; // same link again
    throw new WalletConflict(mine ? "user already has a different wallet" : "address is already linked to a different user");
  }

  async withKeypair<T>(userId: string, fn: (kp: Keypair) => Promise<T>): Promise<T> {
    const r = await this.row(userId);
    if (!r?.custodial) throw new Error(`no wallet for ${userId}`);
    const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey(this.env), Buffer.from(r.iv, "hex"));
    decipher.setAuthTag(Buffer.from(r.tag, "hex"));
    const secret = Buffer.concat([decipher.update(Buffer.from(r.ciphertext, "hex")), decipher.final()]);
    const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
    try {
      if (kp.publicKey.toBase58() !== r.address) throw new Error("custody wallet identity mismatch");
      return await fn(kp);
    } finally {
      secret.fill(0);
      kp.secretKey.fill(0);
    }
  }

  /**
   * Copy the file stores (wallets/, identity/) once. Safe to re-run. A key file is
   * matched to its owner by the userId it records, else by the identity link of
   * its address; files whose owner cannot be established are reported, not guessed.
   */
  async importFiles(dir: string): Promise<{ wallets: number; links: number; unresolved: string[] }> {
    await this.migrate();
    const identity = path.join(dir, "identity");
    const ownerOfAddress = (address: string) => {
      const f = path.join(identity, "by-address", `${address.replace(/[^a-zA-Z0-9_-]/g, "_")}.txt`);
      return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : null;
    };
    let wallets = 0, links = 0;
    const unresolved: string[] = [];
    const walletDir = path.join(dir, "wallets");
    for (const file of fs.existsSync(walletDir) ? fs.readdirSync(walletDir).filter(f => f.endsWith(".json")) : []) {
      const rec = JSON.parse(fs.readFileSync(path.join(walletDir, file), "utf8")) as { userId?: string; publicKey: string; iv: string; tag: string; ciphertext: string };
      const userId = rec.userId ?? ownerOfAddress(rec.publicKey);
      if (!userId) { unresolved.push(file); continue; }
      const r = await this.pool.query(
        `INSERT INTO wallet_accounts(user_id,address,custodial,iv,tag,ciphertext) VALUES ($1,$2,true,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [userId, rec.publicKey, rec.iv, rec.tag, rec.ciphertext],
      );
      wallets += r.rowCount ?? 0;
    }
    const byAddress = path.join(identity, "by-address");
    for (const file of fs.existsSync(byAddress) ? fs.readdirSync(byAddress).filter(f => f.endsWith(".txt")) : []) {
      const address = file.slice(0, -4), userId = fs.readFileSync(path.join(byAddress, file), "utf8").trim();
      const r = await this.pool.query(`INSERT INTO wallet_accounts(user_id,address,custodial) VALUES ($1,$2,false) ON CONFLICT DO NOTHING`, [userId, address]);
      links += r.rowCount ?? 0;
    }
    return { wallets, links, unresolved };
  }
}

/** The original file stores, for local development and unit tests only. */
export class FileWalletAccounts implements WalletAccounts {
  private identity: IdentityStore;
  constructor(private dir: string, private env: NodeJS.ProcessEnv = process.env) {
    this.identity = new IdentityStore(dir);
  }
  async addressFor(userId: string) {
    return fileWalletAddress(this.dir, userId) ?? this.identity.addressFor(userId);
  }
  async userFor(address: string) {
    return this.identity.userFor(address);
  }
  async custodialAddress(userId: string) {
    return fileWalletAddress(this.dir, userId);
  }
  async provision(userId: string) {
    const linked = this.identity.addressFor(userId);
    const custodial = fileWalletAddress(this.dir, userId);
    if (linked && linked !== custodial) throw new WalletConflict("user already linked an external wallet");
    const wallet = provisionFileWallet(this.dir, userId, this.env);
    this.identity.link(userId, wallet.address);
    return wallet;
  }
  async linkExternal(userId: string, address: string) {
    new PublicKey(address);
    const custodial = fileWalletAddress(this.dir, userId);
    if (custodial && custodial !== address) throw new WalletConflict("user already has a different wallet");
    try {
      this.identity.link(userId, address);
    } catch (error) {
      throw new WalletConflict((error as Error).message);
    }
  }
  withKeypair<T>(userId: string, fn: (kp: Keypair) => Promise<T>) {
    return fileWithKeypair(this.dir, userId, fn, this.env);
  }
}

const shared = new Map<string, WalletAccounts>();

/** The process-wide wallet store: Postgres when the money ledger is Postgres (always in production). */
export function openWalletAccounts(ledger: MoneyLedger, dir: string, env: NodeJS.ProcessEnv = process.env): WalletAccounts {
  if (ledger instanceof PostgresMoneyLedger) {
    if (!shared.has("pg")) shared.set("pg", new PostgresWalletAccounts(ledger.pool, env));
    return shared.get("pg")!;
  }
  if (env.NODE_ENV === "production") throw new Error("wallet accounts require the Postgres money ledger in production");
  const key = `file:${dir}`;
  if (!shared.has(key)) shared.set(key, new FileWalletAccounts(dir, env));
  return shared.get(key)!;
}
