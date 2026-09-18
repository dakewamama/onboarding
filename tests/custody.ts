import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as crypto from "crypto";
import { Keypair } from "@solana/web3.js";
import {
  provisionWallet,
  walletAddressFor,
  withUserKeypair,
} from "../payments/src/custody";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "custody-"));
}
const env = () => ({ KEYSTORE_MASTER_KEY: crypto.randomBytes(32).toString("hex") }) as NodeJS.ProcessEnv;

describe("custody (per-user wallet in the deployed service)", () => {
  it("provisions a wallet and is idempotent", () => {
    const dir = tmp();
    const e = env();
    const first = provisionWallet(dir, "web:1", e);
    assert.isTrue(first.created);
    assert.match(first.address, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/); // base58 pubkey
    const again = provisionWallet(dir, "web:1", e);
    assert.isFalse(again.created);
    assert.equal(again.address, first.address);
    assert.equal(walletAddressFor(dir, "web:1"), first.address);
  });

  it("fails closed without a master key", () => {
    assert.throws(() => provisionWallet(tmp(), "u", {} as NodeJS.ProcessEnv), /KEYSTORE_MASTER_KEY/);
  });

  it("the stored secret decrypts to the same keypair for signing", async () => {
    const dir = tmp();
    const e = env();
    const { address } = provisionWallet(dir, "web:2", e);
    const pub = await withUserKeypair(dir, "web:2", async (kp) => kp.publicKey.toBase58(), e);
    assert.equal(pub, address);
    const kp = await withUserKeypair(dir, "web:2", async (k) => k, e);
    assert.instanceOf(kp, Keypair);
  });

  it("a wrong master key cannot decrypt the wallet", async () => {
    const dir = tmp();
    provisionWallet(dir, "web:3", env());
    let threw = false;
    try {
      await withUserKeypair(dir, "web:3", async () => 0, env()); // different key
    } catch {
      threw = true;
    }
    assert.isTrue(threw);
  });
});
