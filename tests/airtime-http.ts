import { assert } from "chai";
import * as http from "http";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { mountAirtime } from "../payments/src/airtime";
import { DepositLedger } from "../payments/src/funding/depositLedger";
import { SpendLedger } from "../payments/src/funding/spendLedger";
import { IdentityStore } from "../payments/src/identity";

describe("airtime HTTP ambiguity boundary", () => {
  const realFetch = globalThis.fetch;
  let server: http.Server;
  let base: string;
  let dir: string;
  let purchases: number;
  let requestId: string;
  let verdict: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "airtime-http-"));
    new IdentityStore(dir).link("user", "wallet");
    new DepositLedger(dir).credit({ owner: "wallet", signature: "deposit-test", baseUnits: "1000000", commitment: "finalized" });
    purchases = 0;
    verdict = "delivered";
    globalThis.fetch = (async (url, init) => {
      if (String(url).endsWith("/pay")) {
        purchases++;
        requestId = JSON.parse(String(init?.body)).request_id;
        throw new Error("provider accepted then connection reset");
      }
      assert.equal(String(url), "https://sandbox.vtpass.com/api/requery");
      assert.deepEqual(JSON.parse(String(init?.body)), { request_id: requestId });
      return new Response(JSON.stringify({ code: verdict === "delivered" ? "000" : "016", requestId, content: { transactions: { status: verdict } } }));
    }) as typeof fetch;
    const mount = mountAirtime({ INTERNAL_API_TOKEN: "test-token", VTPASS_API_KEY: "test-api", VTPASS_SECRET_KEY: "test-secret", AXIS_USDC_NGN_RATE: "1500", FUNDING_STORE_DIR: dir });
    server = http.createServer((req, res) => { void mount.handle(req, res).then(handled => { if (!handled) { res.writeHead(404); res.end(); } }); });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (server) await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  });

  const body = { owner: "user", network: "mtn", amount: 100, phone: "08031234567", idempotencyKey: "axis-case" };
  function buy() {
    return realFetch(`${base}/airtime`, { method: "POST", headers: { authorization: "Bearer test-token", "content-type": "application/json" }, body: JSON.stringify(body) });
  }
  function status(token = "test-token", key = "axis-case") {
    return realFetch(`${base}/airtime/status?idempotencyKey=${key}`, { headers: { authorization: `Bearer ${token}` } });
  }

  it("returns HTTP 202 IN_DOUBT for timeout and replay; requery settles the same debit", async () => {
    for (let i = 0; i < 2; i++) {
      const response = await buy();
      assert.equal(response.status, 202);
      const value = await response.json() as { status: string; moneyState: string };
      assert.equal(value.status, "in_doubt");
      assert.equal(value.moneyState, "IN_DOUBT");
    }
    assert.equal(purchases, 1);
    const response = await status();
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { moneyState: string }).moneyState, "SETTLED");
    assert.equal(new SpendLedger(dir).records("wallet").length, 1);
  });

  it("confirmed requery failure releases funds, and retry never resubmits", async () => {
    await buy();
    verdict = "failed";
    const response = await status();
    assert.equal(response.status, 200);
    assert.equal((await response.json() as { moneyState: string }).moneyState, "RELEASED");
    assert.equal(new SpendLedger(dir).spentBaseUnits("wallet").toString(), "0");
    await buy();
    assert.equal(purchases, 1);
  });

  it("status is authenticated, and unknown action keys do not imply provider failure", async () => {
    assert.equal((await status("wrong-token")).status, 401);
    const response = await status("test-token", "missing");
    assert.equal(response.status, 202);
    assert.equal((await response.json() as { status: string }).status, "in_doubt");
    assert.equal(purchases, 0);
  });
});
