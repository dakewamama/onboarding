import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  SpendLedger,
  InsufficientBalanceError,
} from "../payments/src/funding/spendLedger";

function tmpLedger(): { ledger: SpendLedger; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spend-ledger-"));
  return { ledger: new SpendLedger(dir), dir };
}
const u = (n: number) => BigInt(n);

describe("SpendLedger (the debit path)", () => {
  it("debits paid, records remnant as pool gain", () => {
    const { ledger } = tmpLedger();
    // user has 1000 available; buys airtime that costs 90, charged 100
    const r = ledger.spend(
      { owner: "wallet1", idempotencyKey: "buy-1", paidBaseUnits: u(100), costBaseUnits: u(90), reason: "airtime" },
      u(1000),
    );
    assert.isTrue(r.applied);
    assert.isFalse(r.duplicate);
    assert.equal(ledger.spentBaseUnits("wallet1").toString(), "100");
    assert.equal(ledger.poolGainBaseUnits().toString(), "10"); // 100 - 90
  });

  it("is idempotent: a replay does not double-charge", () => {
    const { ledger } = tmpLedger();
    const first = ledger.spend(
      { owner: "w", idempotencyKey: "k", paidBaseUnits: u(100), costBaseUnits: u(90), reason: "airtime" },
      u(1000),
    );
    const replay = ledger.spend(
      { owner: "w", idempotencyKey: "k", paidBaseUnits: u(100), costBaseUnits: u(90), reason: "airtime" },
      u(1000),
    );
    assert.isTrue(first.applied);
    assert.isFalse(replay.applied);
    assert.isTrue(replay.duplicate);
    assert.equal(ledger.spentBaseUnits("w").toString(), "100"); // charged once
  });

  it("refuses to overspend the available balance", () => {
    const { ledger } = tmpLedger();
    assert.throws(
      () =>
        ledger.spend(
          { owner: "w", idempotencyKey: "k", paidBaseUnits: u(500), costBaseUnits: u(400), reason: "airtime" },
          u(100),
        ),
      InsufficientBalanceError,
    );
    // nothing was recorded
    assert.equal(ledger.spentBaseUnits("w").toString(), "0");
    assert.isFalse(ledger.hasSpent("w", "k"));
  });

  it("rejects non-positive paid and cost > paid", () => {
    const { ledger } = tmpLedger();
    assert.throws(
      () => ledger.spend({ owner: "w", idempotencyKey: "a", paidBaseUnits: u(0), costBaseUnits: u(0), reason: "x" }, u(10)),
      /positive/,
    );
    assert.throws(
      () => ledger.spend({ owner: "w", idempotencyKey: "b", paidBaseUnits: u(10), costBaseUnits: u(20), reason: "x" }, u(100)),
      /cannot exceed/,
    );
  });

  it("accumulates pool gain across users and purchases", () => {
    const { ledger } = tmpLedger();
    ledger.spend({ owner: "a", idempotencyKey: "1", paidBaseUnits: u(100), costBaseUnits: u(95), reason: "airtime" }, u(1000));
    ledger.spend({ owner: "a", idempotencyKey: "2", paidBaseUnits: u(200), costBaseUnits: u(180), reason: "airtime" }, u(1000));
    ledger.spend({ owner: "b", idempotencyKey: "3", paidBaseUnits: u(50), costBaseUnits: u(48), reason: "airtime" }, u(1000));
    // remnants: 5 + 20 + 2 = 27
    assert.equal(ledger.poolGainBaseUnits().toString(), "27");
    assert.equal(ledger.spentBaseUnits("a").toString(), "300");
    assert.equal(ledger.spentBaseUnits("b").toString(), "50");
  });

  it("survives reopen (durable, restart-safe)", () => {
    const { ledger, dir } = tmpLedger();
    ledger.spend({ owner: "w", idempotencyKey: "k", paidBaseUnits: u(100), costBaseUnits: u(90), reason: "airtime" }, u(1000));
    const reopened = new SpendLedger(dir);
    assert.isTrue(reopened.hasSpent("w", "k"));
    assert.equal(reopened.spentBaseUnits("w").toString(), "100");
    assert.equal(reopened.poolGainBaseUnits().toString(), "10");
  });
});
