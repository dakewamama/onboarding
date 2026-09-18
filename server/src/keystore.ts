import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { KEYSTORE_DIR } from "./config";
import { FileKeyRecordStore } from "./keyRecordStore";
import { makeKeyStore } from "./custodialKeyStore";

/**
 * Custodial key store. Envelope encryption (keyCipher) wraps each per-user secret
 * key under a master key; storage is pluggable (keyRecordStore).
 *
 * This module wires the DEFAULT local instance: a FILE backend. That is fine for
 * dev, but on Railway the container filesystem is ephemeral — keys written here do
 * not survive a redeploy. The next step is a Postgres-backed `KeyRecordStore`
 * (persists across redeploys) with `KEYSTORE_MASTER_KEY` required (no local-file
 * master key in the cloud). The crypto + KeyStore logic are already backend-
 * agnostic; only a new `KeyRecordStore` impl + async wiring is needed.
 *
 * In production the master key should be a non-exportable CMK in a KMS/HSM and
 * signing should happen inside that boundary; this is the local stand-in.
 */

const USERS_DIR = path.join(KEYSTORE_DIR, "users");
const MASTER_KEY_PATH = path.join(KEYSTORE_DIR, "master.key");

export function loadMasterKey(): Buffer {
  fs.mkdirSync(KEYSTORE_DIR, { recursive: true });
  if (process.env.KEYSTORE_MASTER_KEY) {
    const key = Buffer.from(process.env.KEYSTORE_MASTER_KEY, "hex");
    if (key.length !== 32) {
      throw new Error("KEYSTORE_MASTER_KEY must be 32 bytes (64 hex chars)");
    }
    return key;
  }
  // Devnet stand-in only: a generated local master key. Not viable in the cloud
  // (ephemeral fs) — set KEYSTORE_MASTER_KEY there.
  if (!fs.existsSync(MASTER_KEY_PATH)) {
    fs.writeFileSync(MASTER_KEY_PATH, crypto.randomBytes(32).toString("hex"), {
      mode: 0o600,
    });
    console.warn(
      "[keystore] generated a local master key — devnet stand-in for a KMS CMK",
    );
  }
  return Buffer.from(fs.readFileSync(MASTER_KEY_PATH, "utf8").trim(), "hex");
}

const impl = makeKeyStore(new FileKeyRecordStore(USERS_DIR), loadMasterKey);

export const createUserKey = impl.createUserKey;
export const getUserPublicKey = impl.getUserPublicKey;
export const userExists = impl.userExists;
export const withUserKeypair = impl.withUserKeypair;
