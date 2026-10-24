import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IdentityStore } from "../payments/src/identity";
import { DepositLedger } from "../payments/src/funding/depositLedger";
import { SpendLedger } from "../payments/src/funding/spendLedger";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "identity-"));
}

describe("IdentityStore (userId <-> custodial wallet)", () => {
  it("links and resolves both directions", () => {
    const id = new IdentityStore(tmp());
    id.link("web:abc", "Wa11etAddr111");
    assert.equal(id.addressFor("web:abc"), "Wa11etAddr111");
    assert.equal(id.userFor("Wa11etAddr111"), "web:abc");
    assert.isNull(id.addressFor("nope"));
  });

  it("is idempotent but refuses a conflicting remap", () => {
    const id = new IdentityStore(tmp());
    id.link("u", "addrA");
    assert.doesNotThrow(() => id.link("u", "addrA")); // same pair is fine
    assert.throws(() => id.link("u", "addrB"), /different wallet/);
  });

  it("keeps ids that differ only in punctuation apart, and an address has one user", () => {
    const id = new IdentityStore(tmp());
    id.link("web:1", "addrA");
    assert.isNull(id.addressFor("web_1"));
    assert.throws(() => id.link("web_1", "addrA"), /different user/);
    id.link("web_1", "addrB");
    assert.equal(id.addressFor("web:1"), "addrA");
    assert.equal(id.addressFor("web_1"), "addrB");
  });

  it("reads a pre-hash link only for its exact owner", () => {
    const dir = tmp();
    const id = new IdentityStore(dir);
    fs.writeFileSync(path.join(dir, "identity", "by-user", "web_1.txt"), "addrL");
    fs.writeFileSync(path.join(dir, "identity", "by-address", "addrL.txt"), "web:1");
    assert.isNull(id.addressFor("web_1"));
    assert.equal(id.addressFor("web:1"), "addrL");
  });
});

describe("balance reconciliation (the fix)", () => {
  it("a deposit credited to the wallet address is spendable via the userId", () => {
    const dir = tmp();
    const id = new IdentityStore(dir);
    const deposits = new DepositLedger(dir);
    const spends = new SpendLedger(dir);

    const userId = "web:abc";
    const wallet = "Wa11etAddr111";
    id.link(userId, wallet);

    // The watcher credits by ADDRESS (as it does on-chain).
    deposits.credit({ signature: "sig1", owner: wallet, baseUnits: "1000000", commitment: "finalized" });

    // The airtime edge resolves userId -> address, then keys balance by address.
    const owner = id.addressFor(userId)!;
    const available = deposits.balanceBaseUnits(owner) - spends.spentBaseUnits(owner);
    assert.equal(available.toString(), "1000000"); // reconciles — was 0 before the fix

    // A debit under the same resolved key draws it down.
    spends.spend(
      { owner, idempotencyKey: "k1", paidBaseUnits: BigInt(400000), costBaseUnits: BigInt(380000), reason: "airtime" },
      available,
    );
    const after = deposits.balanceBaseUnits(owner) - spends.spentBaseUnits(owner);
    assert.equal(after.toString(), "600000");
  });

  it("keying by raw userId (the old bug) never sees the deposit", () => {
    const dir = tmp();
    const deposits = new DepositLedger(dir);
    deposits.credit({ signature: "sig1", owner: "Wa11etAddr111", baseUnits: "1000000", commitment: "finalized" });
    // The pre-fix path keyed balance by the userId string directly.
    assert.equal(deposits.balanceBaseUnits("web:abc").toString(), "0");
  });
});
