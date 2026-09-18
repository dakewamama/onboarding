import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fulfillAirtime, AirtimeFulfillDeps } from "../payments/src/airtimeFulfill";
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
    voidSpend: (owner, key) => spends.void(owner, key),
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

describe("fulfillAirtime (reserve -> deliver -> void)", () => {
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

  it("hard failure voids the debit (no charge stands)", async () => {
    const spends = tmpSpend();
    const r = await fulfillAirtime(deps(spends, BigInt(1_000_000), async () => failed), {
      owner: "w", network: "mtn", amount: 100, phone: "08031234567", idempotencyKey: "k2",
    });
    assert.equal(r.status, "failed");
    assert.equal(spends.spentBaseUnits("w").toString(), "0"); // released
    assert.isFalse(spends.hasSpent("w", "k2"));
  });

  it("a thrown delivery error voids the debit and rethrows", async () => {
    const spends = tmpSpend();
    let threw = false;
    try {
      await fulfillAirtime(
        deps(spends, BigInt(1_000_000), async () => {
          throw new Error("network down");
        }),
        { owner: "w", network: "mtn", amount: 100, phone: "080", idempotencyKey: "k3" },
      );
    } catch {
      threw = true;
    }
    assert.isTrue(threw);
    assert.equal(spends.spentBaseUnits("w").toString(), "0");
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
    assert.equal(second.status, "duplicate");
    assert.equal(calls, 1); // delivered once
  });
});
