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

  it("never gives two users the same wallet, even when their ids differ only in punctuation", () => {
    const dir = tmp();
    const e = env();
    const a = provisionWallet(dir, "web:1", e);
    const b = provisionWallet(dir, "web_1", e);
    assert.isTrue(b.created);
    assert.notEqual(a.address, b.address);
  });

  it("a pre-hash wallet file is claimed by its first exact owner and refused to others", () => {
    const dir = tmp();
    const e = env();
    const { address } = provisionWallet(dir, "web_9", e);
    // Recreate the old layout: the same record under the punctuation-folded name, no owner field.
    const wallets = path.join(dir, "wallets");
    const own = fs.readdirSync(wallets).find((f) => f.startsWith("u_"))!;
    const rec = JSON.parse(fs.readFileSync(path.join(wallets, own), "utf8"));
    delete rec.userId;
    fs.rmSync(path.join(wallets, own));
    fs.writeFileSync(path.join(wallets, "web_9.json"), JSON.stringify(rec));
    assert.equal(walletAddressFor(dir, "web:9"), address, "first exact reader claims it");
    assert.isTrue(fs.existsSync(path.join(wallets, "web_9.json.migrated")));
    assert.isNull(walletAddressFor(dir, "web_9"), "the old file is no longer anyone else's");
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
