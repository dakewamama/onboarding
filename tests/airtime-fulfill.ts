import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fulfillAirtime, requeryAirtime, AirtimeFulfillDeps } from "../payments/src/airtimeFulfill";
import { usdcToNgnRate, ngnToUsdcBase, offRampNgnPerUsdc } from "../payments/src/rate";
import { SpendLedger, InsufficientBalanceError } from "../payments/src/funding/spendLedger";
import type { AirtimeResult } from "../payments/src/vtpassClient";

function tmpSpend(): SpendLedger {
  return new SpendLedger(fs.mkdtempSync(path.join(os.tmpdir(), "fulfill-")));
}
const RATE = 1500; // NGN per USDC
const delivered: AirtimeResult = { success: true, status: "delivered", code: "000", description: "ok", raw: {} };
const failed: AirtimeResult = { success: false, status: "failed", code: "016", description: "no", raw: {} };
const pending: AirtimeResult = { success: false, status: "pending", code: "000", description: "processing", raw: {} };

function deps(
  spends: SpendLedger,
  available: bigint,
  buyAirtime: () => Promise<AirtimeResult>,
): AirtimeFulfillDeps {
  return {
    getRate: async () => RATE,
    marginBps: 0,
    availableBaseUnits: () => available - spends.spentBaseUnits("w"),
    spend: (input, avail) => spends.spend(input, avail),
    getSpend: (owner, key) => spends.get(owner, key),
    findSpend: key => spends.findByKey(key),
    setState: (owner, key, state) => spends.setState(owner, key, state),
    requery: async requestId => ({ ...pending, requestId }),
    buyAirtime,
  };
}

describe("rate", () => {
  it("usdcToNgnRate is fail-closed", () => {
    assert.throws(() => usdcToNgnRate({} as NodeJS.ProcessEnv), /AXIS_USDC_NGN_RATE/);
    assert.equal(usdcToNgnRate({ AXIS_USDC_NGN_RATE: "1500" } as any), 1500);
  });
  it("ngnToUsdcBase rounds up to 6dp", () => {
    // 100 NGN / 1500 = 0.066666... USDC -> ceil to 0.066667 -> 66667 base units
    assert.equal(ngnToUsdcBase(100, 1500).toString(), "66667");
  });
  it("offRampNgnPerUsdc pulls the Paj off-ramp rate", () => {
    assert.equal(offRampNgnPerUsdc({ offRampRate: { rate: 1650 } }), 1650);
    assert.isNull(offRampNgnPerUsdc({ onRampRate: { rate: 1650 } })); // wrong field
    assert.isNull(offRampNgnPerUsdc({}));
    assert.isNull(offRampNgnPerUsdc(null));
  });
});

describe("fulfillAirtime (reserve -> deliver -> reconcile)", () => {
  it("delivered: charges, books remnant, keeps the debit", async () => {
    const spends = tmpSpend();
    // 5% margin so paid > cost and remnant is positive
    const d = { ...deps(spends, BigInt(1_000_000), async () => delivered), marginBps: 500 };
    const r = await fulfillAirtime(d, {
      owner: "w", network: "mtn", amount: 100, phone: "08031234567", idempotencyKey: "k1",
    });
    assert.equal(r.status, "delivered");
    assert.equal(spends.spentBaseUnits("w").toString(), r.chargedBaseUnits);
    assert.isAbove(Number(r.remnantBaseUnits), 0);
    assert.equal(spends.poolGainBaseUnits().toString(), r.remnantBaseUnits);
  });

  it("hard failure releases the debit while retaining its identity", async () => {
    const spends = tmpSpend();
    const r = await fulfillAirtime(deps(spends, BigInt(1_000_000), async () => failed), {
      owner: "w", network: "mtn", amount: 100, phone: "08031234567", idempotencyKey: "k2",
    });
    assert.equal(r.status, "failed");
    assert.equal(spends.spentBaseUnits("w").toString(), "0"); // released
    assert.isFalse(spends.hasSpent("w", "k2"));
  });

  it("a thrown delivery error leaves the debit IN_DOUBT", async () => {
    const spends = tmpSpend();
    const r = await fulfillAirtime(deps(spends, BigInt(1_000_000), async () => { throw new Error("timeout"); }), {
      owner: "w", network: "mtn", amount: 100, phone: "080", idempotencyKey: "k3",
    });
    assert.equal(r.status, "in_doubt");
    assert.equal(r.moneyState, "IN_DOUBT");
    assert.isAbove(Number(spends.spentBaseUnits("w")), 0);
  });

  it("pending keeps the debit (202-style)", async () => {
    const spends = tmpSpend();
    const r = await fulfillAirtime(deps(spends, BigInt(1_000_000), async () => pending), {
      owner: "w", network: "mtn", amount: 100, phone: "080", idempotencyKey: "k4",
    });
    assert.equal(r.status, "pending");
    assert.isAbove(Number(spends.spentBaseUnits("w")), 0);
  });

  it("insufficient balance never delivers", async () => {
    const spends = tmpSpend();
    let delivered_called = false;
    let threw = false;
    try {
      await fulfillAirtime(
        deps(spends, BigInt(1), async () => {
          delivered_called = true;
          return delivered;
        }),
        { owner: "w", network: "mtn", amount: 100, phone: "080", idempotencyKey: "k5" },
      );
    } catch (e) {
      threw = e instanceof InsufficientBalanceError;
    }
    assert.isTrue(threw);
    assert.isFalse(delivered_called);
  });

  it("duplicate key does not re-deliver or double-charge", async () => {
    const spends = tmpSpend();
    let calls = 0;
    const mk = () =>
      fulfillAirtime(
        { ...deps(spends, BigInt(1_000_000), async () => { calls++; return delivered; }), marginBps: 500 },
        { owner: "w", network: "mtn", amount: 100, phone: "080", idempotencyKey: "same" },
      );
    await mk();
    const second = await mk();
    assert.equal(second.status, "delivered");
    assert.equal(second.moneyState, "SETTLED");
    assert.equal(calls, 1); // delivered once
  });
});


describe("airtime reconciliation safety", () => {
  const params = { owner: "w", network: "mtn", amount: 100, phone: "080", idempotencyKey: "stable-action" };

  it("same action reuses its persisted request identity across restart and rate outage", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "airtime-restart-"));
    const ledger = new SpendLedger(dir);
    let calls = 0;
    let submittedId = "";
    const d = deps(ledger, BigInt(1_000_000), async () => pending);
    d.buyAirtime = async p => { calls++; submittedId = p.requestId; throw new Error("accepted then timeout"); };
    const first = await fulfillAirtime(d, params);
    const reopened = deps(new SpendLedger(dir), BigInt(1_000_000), async () => { calls++; return delivered; });
    reopened.getRate = async () => { throw new Error("rate unavailable"); };
    const replay = await fulfillAirtime(reopened, params);
    assert.equal(first.requestId, submittedId);
    assert.equal(replay.requestId, submittedId);
    assert.equal(replay.status, "in_doubt");
    assert.equal(calls, 1);
    assert.equal(ledger.records("w").length, 1);
  });

  it("concurrent retries submit one purchase and reserve one debit", async () => {
    const ledger = tmpSpend();
    let calls = 0;
    const d = deps(ledger, BigInt(1_000_000), async () => { calls++; return pending; });
    const results = await Promise.all(Array.from({ length: 8 }, () => fulfillAirtime(d, params)));
    assert.equal(calls, 1);
    assert.equal(new Set(results.map(r => r.requestId)).size, 1);
    assert.equal(ledger.records("w").length, 1);
  });

  for (const outcome of [
    { ...failed, code: "014", status: "unknown" },
    { ...failed, status: "unknown" },
    { ...delivered, code: "999" },
    { ...failed, requestId: "wrong-request" },
  ]) {
    it(`ambiguous ${outcome.code}/${outcome.status}/${outcome.requestId ?? ""} retains funds`, async () => {
      const ledger = tmpSpend();
      const r = await fulfillAirtime(deps(ledger, BigInt(1_000_000), async () => outcome), params);
      assert.equal(r.moneyState, "IN_DOUBT");
      assert.isAbove(Number(ledger.spentBaseUnits("w")), 0);
      assert.equal(ledger.poolGainBaseUnits().toString(), "0");
    });
  }

  for (const [verdict, state] of [[delivered, "SETTLED"], [failed, "RELEASED"], [{ ...failed, code: "040", status: "reversed" }, "REVERSED"]] as const) {
    it(`requery authoritative verdict becomes ${state}, idempotently`, async () => {
      const ledger = tmpSpend();
      let purchases = 0;
      const d = deps(ledger, BigInt(1_000_000), async () => { purchases++; throw new Error("timeout"); });
      const first = await fulfillAirtime(d, params);
      d.requery = async requestId => {
        assert.equal(requestId, first.requestId);
        return { ...verdict, requestId };
      };
      const resolved = await requeryAirtime(d, params.idempotencyKey);
      assert.equal(resolved?.moneyState, state);
      assert.equal(ledger.get("w", params.idempotencyKey)?.state, state);
      assert.deepEqual(await requeryAirtime(d, params.idempotencyKey), resolved);
      assert.deepEqual(await fulfillAirtime(d, params), resolved);
      assert.equal(purchases, 1);
      if (state !== "SETTLED") assert.equal(ledger.spentBaseUnits("w").toString(), "0");
    });
  }

  it("missing/mismatched requery correlation and requery timeout remain IN_DOUBT", async () => {
    const ledger = tmpSpend();
    const d = deps(ledger, BigInt(1_000_000), async () => pending);
    await fulfillAirtime(d, params);
    for (const requestId of [undefined, "another-purchase"]) {
      d.requery = async () => ({ ...delivered, requestId });
      assert.equal((await requeryAirtime(d, params.idempotencyKey))?.moneyState, "IN_DOUBT");
    }
    d.requery = async () => { throw new Error("timeout"); };
    assert.equal((await requeryAirtime(d, params.idempotencyKey))?.moneyState, "IN_DOUBT");
    assert.isAbove(Number(ledger.spentBaseUnits("w")), 0);
  });

  it("rejects reuse of an action key with different purchase parameters", async () => {
    const d = deps(tmpSpend(), BigInt(1_000_000), async () => pending);
    await fulfillAirtime(d, params);
    try {
      await fulfillAirtime(d, { ...params, amount: 200 });
      assert.fail("expected identity conflict");
    } catch (err) {
      assert.match((err as Error).message, /another purchase/);
    }
  });

  it("legacy debit without provider identity cannot claim delivery or issue a requery", async () => {
    const ledger = tmpSpend();
    ledger.spend({ owner: "w", idempotencyKey: params.idempotencyKey, paidBaseUnits: BigInt(10), costBaseUnits: BigInt(10), reason: "legacy" }, BigInt(100));
    const d = deps(ledger, BigInt(1_000_000), async () => { throw new Error("must not purchase"); });
    d.requery = async () => { assert.fail("must not invent provider identity"); };
    assert.equal((await fulfillAirtime(d, params)).status, "in_doubt");
    assert.equal((await requeryAirtime(d, params.idempotencyKey))?.status, "in_doubt");
  });
});

describe("concurrent purchase budget", () => {
  it("two distinct actions cannot spend the same available funds in one service process", async () => {
    const ledger = tmpSpend();
    let purchases = 0;
    const d = deps(ledger, BigInt(66667), async () => { purchases++; return pending; });
    const attempts = await Promise.allSettled(["one", "two"].map(idempotencyKey => fulfillAirtime(d, {
      owner: "w", network: "mtn", amount: 100, phone: "080", idempotencyKey,
    })));
    assert.equal(attempts.filter(r => r.status === "fulfilled").length, 1);
    assert.equal(purchases, 1);
    assert.equal(ledger.records("w").length, 1);
  });
});
