import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Connection, Keypair } from "@solana/web3.js";

// Devnet by default. The operator (gas + fee payer, and mint authority in the
// demo) is the local Solana CLI wallet unless ANCHOR_WALLET overrides it.
export const RPC_URL =
  process.env.ANCHOR_PROVIDER_URL ?? "https://api.devnet.solana.com";

export const SERVER_DIR = path.resolve(__dirname, "..");
export const KEYSTORE_DIR = path.join(SERVER_DIR, ".keystore");
export const AUDIT_DIR = path.join(SERVER_DIR, ".audit");

function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadOperatorKeypair(): Keypair {
  const p = expandHome(
    process.env.ANCHOR_WALLET ?? path.join(os.homedir(), ".config/solana/id.json")
  );
  const secret = JSON.parse(fs.readFileSync(p, "utf8"));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

export function connection(): Connection {
  return new Connection(RPC_URL, "confirmed");
}
