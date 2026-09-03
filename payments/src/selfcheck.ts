/**
 * Offline self-check for the pure logic (no Paj network, no credentials):
 * money conversion, signature verify, status vocab, store idempotency,
 * settlement parsing, and the end-to-end webhook handler including
 * duplicate-suppression and signature rejection.
 *
 *   yarn run paj-selfcheck
 */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { toBaseUnits, fromBaseUnits, toWireAmount } from "./money";
import { signWebhook, verifyWebhookSignature } from "./webhook";
import { isSuccess, isFailure, isTerminal } from "./status";
import { PaymentStore } from "./store";
import { PajProvider } from "./pajProvider";
import { handleWebhook } from "./webhookHandler";
import { PajConfig } from "./config";
import { Settlement } from "./types";

let passed = 0;
function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  ok  ${name}`);
    })
    .catch((err) => {
      console.error(`FAIL  ${name}\n      ${err.message}`);
      process.exitCode = 1;
    });
}

function tmpStoreDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "paj-selfcheck-"));
}

function testConfig(storeDir: string): PajConfig {
  return {
    apiKey: "test",
    webhookSecret: "whsec_" + "a".repeat(64),
    env: "staging",
    mode: "PAYMENT",
    chain: "SOLANA",
    mint: "So11111111111111111111111111111111111111112",
    currency: "NGN",
    storeDir,
  };
}

async function main() {
  // --- money ---
  await check("toBaseUnits parses decimals", () => {
    assert.strictEqual(toBaseUnits("33.11").toString(), "33110000");
    assert.strictEqual(toBaseUnits("1").toString(), "1000000");
    assert.strictEqual(toBaseUnits("0.000001").toString(), "1");
  });
  await check("fromBaseUnits/toWireAmount round-trip", () => {
    assert.strictEqual(fromBaseUnits(BigInt(33110000)), "33.11");
    assert.strictEqual(toWireAmount(BigInt(33110000)), 33.11);
    assert.strictEqual(fromBaseUnits(BigInt(1000000)), "1");
  });
  await check("money rejects floats and over-precision", () => {
    assert.throws(() => toBaseUnits("33.1.1"));
    assert.throws(() => toBaseUnits("0.0000001")); // 7 dp > 6
    assert.throws(() => toBaseUnits("abc"));
  });

  // --- status vocab (both cases) ---
  await check("status vocab is defensive", () => {
    assert.ok(isSuccess("SUCCESSFUL") && isSuccess("COMPLETED") && isSuccess("completed"));
    assert.ok(isFailure("FAILED") && isFailure("cancelled") && isFailure("EXPIRED") && isFailure("ERROR"));
    assert.ok(isTerminal("SUCCESSFUL") && isTerminal("FAILED"));
    assert.ok(!isTerminal("PROCESSING") && !isTerminal("INIT") && !isTerminal("AWAITING"));
  });

  // --- signature verify ---
  const secret = "whsec_" + "a".repeat(64);
  await check("valid signature verifies", () => {
    const body = '{"id":"pay_1","status":"SUCCESSFUL","amount":25.5}';
    const ts = Math.floor(Date.now() / 1000);
    const sig = signWebhook(body, ts, secret);
    assert.ok(verifyWebhookSignature(body, sig, String(ts), secret).valid);
  });
  await check("tampered body fails", () => {
    const ts = Math.floor(Date.now() / 1000);
    const sig = signWebhook('{"id":"pay_1"}', ts, secret);
    assert.ok(!verifyWebhookSignature('{"id":"pay_2"}', sig, String(ts), secret).valid);
  });
  await check("stale timestamp fails", () => {
    const body = '{"id":"pay_1"}';
    const old = Math.floor(Date.now() / 1000) - 4000;
    const sig = signWebhook(body, old, secret);
    assert.ok(!verifyWebhookSignature(body, sig, String(old), secret).valid);
  });
  await check("missing headers fail", () => {
    assert.ok(!verifyWebhookSignature("{}", undefined, "1", secret).valid);
    assert.ok(!verifyWebhookSignature("{}", "v1=abcd", undefined, secret).valid);
  });

  // --- store idempotency ---
  await check("store links and dedupes", () => {
    const store = new PaymentStore(tmpStoreDir());
    store.link("order-1", "paj-1");
    assert.strictEqual(store.pajIdFor("order-1"), "paj-1");
    assert.strictEqual(store.orderReferenceFor("paj-1"), "order-1");
    assert.strictEqual(store.isSettled("paj-1"), false);
    assert.strictEqual(store.markSettled("paj-1", {}), true);
    assert.strictEqual(store.markSettled("paj-1", {}), false); // idempotent
    assert.strictEqual(store.isSettled("paj-1"), true);
  });

  // --- createPayment maps + links (stubbed client, no network) ---
  await check("createPayment (PAYMENT) links order->pajId", async () => {
    const dir = tmpStoreDir();
    const fakeClient: any = {
      createPayment: async () => ({ id: "paj-xyz", token: { address: "DepositAddr111" } }),
    };
    const provider = new PajProvider(testConfig(dir), fakeClient, new PaymentStore(dir));
    const res = await provider.createPayment({
      orderReference: "ord-9",
      amountUsdc: "12.5",
      recipient: {},
    });
    assert.strictEqual(res.pajId, "paj-xyz");
    assert.strictEqual(res.depositAddress, "DepositAddr111");
    assert.strictEqual(await provider.confirmSettled("paj-xyz"), false);
  });

  // --- full webhook pipeline ---
  await check("handleWebhook credits once, ignores dupes, rejects bad sig", async () => {
    const dir = tmpStoreDir();
    const cfg = testConfig(dir);
    const store = new PaymentStore(dir);
    const provider = new PajProvider(cfg, {} as any, store);
    store.link("ord-42", "paj-42");

    const body = JSON.stringify({ id: "paj-42", status: "SUCCESSFUL", usdcAmount: 50 });
    const ts = Math.floor(Date.now() / 1000);
    const sig = signWebhook(body, ts, cfg.webhookSecret);
    const headers = { "x-paj-signature": sig, "x-paj-timestamp": String(ts) };

    let credited: Settlement[] = [];
    const onCredit = async (s: Settlement) => {
      credited.push(s);
    };

    const r1 = await handleWebhook(provider, body, headers, onCredit);
    assert.strictEqual(r1.credited, true);
    assert.strictEqual(r1.settlement?.reference, "ord-42");
    assert.strictEqual(r1.settlement?.amountUsdc, "50");

    const r2 = await handleWebhook(provider, body, headers, onCredit);
    assert.strictEqual(r2.credited, false); // duplicate suppressed
    assert.strictEqual(credited.length, 1); // credited exactly once

    const bad = await handleWebhook(provider, body, { ...headers, "x-paj-signature": "v1=deadbeef" }, onCredit);
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(credited.length, 1);
  });

  await check("handleWebhook acknowledges signed test/unknown id without crediting", async () => {
    const dir = tmpStoreDir();
    const cfg = testConfig(dir);
    const provider = new PajProvider(cfg, {} as any, new PaymentStore(dir));
    // A properly signed, SUCCESSFUL payload for an id we never created (mirrors
    // Paj's test-webhook sample). Must return 200 (delivered) but not credit.
    const body = JSON.stringify({ id: "test_sample_1", status: "SUCCESSFUL", usdcAmount: 1 });
    const ts = Math.floor(Date.now() / 1000);
    let credited = 0;
    const r = await handleWebhook(provider, body, sign(body, ts, cfg.webhookSecret), async () => {
      credited++;
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.credited, false);
    assert.strictEqual(credited, 0);
    assert.match(r.note, /unknown pajId/);
  });

  await check("handleWebhook ignores non-terminal + terminal failure", async () => {
    const dir = tmpStoreDir();
    const cfg = testConfig(dir);
    const provider = new PajProvider(cfg, {} as any, new PaymentStore(dir));
    const ts = Math.floor(Date.now() / 1000);

    const pending = JSON.stringify({ id: "p1", status: "PROCESSING" });
    const r1 = await handleWebhook(provider, pending, sign(pending, ts, cfg.webhookSecret), noop);
    assert.strictEqual(r1.credited, false);
    assert.match(r1.note, /non-terminal/);

    const failed = JSON.stringify({ id: "p2", status: "FAILED" });
    const r2 = await handleWebhook(provider, failed, sign(failed, ts, cfg.webhookSecret), noop);
    assert.strictEqual(r2.credited, false);
    assert.match(r2.note, /failure/);
  });

  console.log(`\n${passed} checks passed`);
}

const noop = async () => {};
function sign(body: string, ts: number, secret: string) {
  return { "x-paj-signature": signWebhook(body, ts, secret), "x-paj-timestamp": String(ts) };
}

main();
