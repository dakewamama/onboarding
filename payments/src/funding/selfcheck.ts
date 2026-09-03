/**
 * Offline self-check for the crypto-funding logic (no RPC, no network):
 * ledger idempotency, crash-safe balance derivation, and the credit-exactly-once
 * discipline that gates the balance.
 *
 *   npm run funding-selfcheck
 */
import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { toBaseUnits, fromBaseUnits } from "../money";
import { DepositLedger } from "./depositLedger";

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

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "funding-selfcheck-"));
}

const OWNER = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PB5uNhg"; // valid-looking base58

async function main() {
  await check("ledger credits a signature exactly once (idempotent)", () => {
    const ledger = new DepositLedger(tmpDir());
    const deposit = {
      signature: "sigAAA",
      owner: OWNER,
      baseUnits: toBaseUnits("12.5").toString(),
      commitment: "finalized",
    };
    assert.strictEqual(ledger.hasCredited(OWNER, "sigAAA"), false);
    assert.strictEqual(ledger.credit(deposit), true); // first time credits
    assert.strictEqual(ledger.credit(deposit), false); // duplicate suppressed
    assert.strictEqual(ledger.hasCredited(OWNER, "sigAAA"), true);
  });

  await check("balance is the derived sum of credited deposits", () => {
    const ledger = new DepositLedger(tmpDir());
    ledger.credit({ signature: "s1", owner: OWNER, baseUnits: toBaseUnits("10").toString(), commitment: "finalized" });
    ledger.credit({ signature: "s2", owner: OWNER, baseUnits: toBaseUnits("0.250001").toString(), commitment: "finalized" });
    ledger.credit({ signature: "s2", owner: OWNER, baseUnits: toBaseUnits("999").toString(), commitment: "finalized" }); // dup sig ignored
    assert.strictEqual(fromBaseUnits(ledger.balanceBaseUnits(OWNER)), "10.250001");
  });

  await check("balance survives a fresh ledger over the same dir (restart-safe)", () => {
    const dir = tmpDir();
    const a = new DepositLedger(dir);
    a.credit({ signature: "s9", owner: OWNER, baseUnits: toBaseUnits("42").toString(), commitment: "finalized" });
    const b = new DepositLedger(dir); // simulate a restart
    assert.strictEqual(fromBaseUnits(b.balanceBaseUnits(OWNER)), "42");
    assert.strictEqual(b.credit({ signature: "s9", owner: OWNER, baseUnits: toBaseUnits("42").toString(), commitment: "finalized" }), false);
  });

  await check("zero / non-positive deposits are never credited", () => {
    const ledger = new DepositLedger(tmpDir());
    assert.strictEqual(ledger.credit({ signature: "z1", owner: OWNER, baseUnits: "0", commitment: "finalized" }), false);
    assert.strictEqual(ledger.balanceBaseUnits(OWNER).toString(), "0");
  });

  await check("money boundary rejects floats / over-precision", () => {
    assert.strictEqual(toBaseUnits("1").toString(), "1000000");
    assert.throws(() => toBaseUnits("0.0000001")); // 7 dp > 6
    assert.throws(() => toBaseUnits("1.2.3"));
  });

  console.log(`\n${passed} checks passed`);
}

main();
