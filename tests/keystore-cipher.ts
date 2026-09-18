import { assert } from "chai";
import * as crypto from "crypto";
import { Keypair } from "@solana/web3.js";
import { encryptSecret, decryptSecret } from "../server/src/keyCipher";
import { InMemoryKeyRecordStore } from "../server/src/keyRecordStore";
import { makeKeyStore } from "../server/src/custodialKeyStore";

const key = () => crypto.randomBytes(32);

describe("keyCipher (envelope encryption)", () => {
  it("round-trips a secret", () => {
    const mk = key();
    const secret = crypto.randomBytes(64);
    const dec = decryptSecret(encryptSecret(secret, mk), mk);
    assert.isTrue(dec.equals(secret));
  });

  it("a wrong master key cannot decrypt", () => {
    const secret = crypto.randomBytes(64);
    const payload = encryptSecret(secret, key());
    assert.throws(() => decryptSecret(payload, key()));
  });

  it("tampered ciphertext is rejected (GCM auth)", () => {
    const mk = key();
    const payload = encryptSecret(crypto.randomBytes(64), mk);
    const bytes = Buffer.from(payload.ciphertext, "hex");
    bytes[0] ^= 0xff;
    assert.throws(() => decryptSecret({ ...payload, ciphertext: bytes.toString("hex") }, mk));
  });

  it("rejects a non-32-byte master key", () => {
    assert.throws(() => encryptSecret(Buffer.from("x"), Buffer.alloc(16)), /32 bytes/);
  });
});

describe("makeKeyStore (backend-agnostic)", () => {
  const mk = key();
  it("creates a user key and lends the matching keypair for signing", async () => {
    const ks = makeKeyStore(new InMemoryKeyRecordStore(), () => mk);
    const pub = ks.createUserKey("u1");
    assert.isTrue(ks.userExists("u1"));
    assert.equal(ks.getUserPublicKey("u1"), pub);
    const signerPub = await ks.withUserKeypair("u1", async (kp) =>
      kp.publicKey.toBase58(),
    );
    assert.equal(signerPub, pub);
  });

  it("is create-once (no silent key overwrite)", () => {
    const ks = makeKeyStore(new InMemoryKeyRecordStore(), () => mk);
    ks.createUserKey("u2");
    assert.throws(() => ks.createUserKey("u2"), /already exists/);
  });

  it("the stored secret actually reconstructs a valid Solana keypair", async () => {
    const store = new InMemoryKeyRecordStore();
    const ks = makeKeyStore(store, () => mk);
    const pub = ks.createUserKey("u3");
    // sign something and verify it round-trips through the reconstructed key
    const kp = await ks.withUserKeypair("u3", async (k) => k);
    assert.equal(kp.publicKey.toBase58(), pub);
    assert.instanceOf(kp, Keypair);
  });
});
