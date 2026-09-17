import { assert } from "chai";
import { bearerOk } from "../server/src/httpAuth";
import {
  checkAuthorization,
  type Authorization,
} from "../server/src/authorizations";

describe("custody server auth (P0 item 4)", () => {
  describe("bearerOk — fails closed", () => {
    it("denies when no token is configured, even with a header", () => {
      assert.isFalse(bearerOk("Bearer anything", undefined));
      assert.isFalse(bearerOk("Bearer anything", ""));
    });
    it("denies a missing or malformed header", () => {
      assert.isFalse(bearerOk(undefined, "secret"));
      assert.isFalse(bearerOk("secret", "secret")); // no "Bearer " prefix
      assert.isFalse(bearerOk("Bearer ", "secret"));
    });
    it("denies a wrong token and accepts the exact one", () => {
      assert.isFalse(bearerOk("Bearer nope", "secret"));
      assert.isTrue(bearerOk("Bearer secret", "secret"));
    });
  });

  describe("checkAuthorization — zero means zero", () => {
    const base: Authorization = {
      userId: "u1",
      scope: ["withdraw"],
      maxAmountPerTx: 0,
      grantedAt: new Date().toISOString(),
    };

    it("denies any positive amount when the cap is zero", () => {
      assert.throws(() => checkAuthorization(base, "withdraw", 1), /exceeds/);
      assert.throws(() => checkAuthorization(base, "withdraw", 1_000_000), /exceeds/);
    });
    it("denies an unscoped action", () => {
      assert.throws(
        () => checkAuthorization(base, "deposit", 1),
        /has not authorized/
      );
    });
    it("denies a non-positive amount", () => {
      const capped = { ...base, maxAmountPerTx: 100 };
      assert.throws(() => checkAuthorization(capped, "withdraw", 0), /positive/);
      assert.throws(() => checkAuthorization(capped, "withdraw", -5), /positive/);
    });
    it("allows an amount within an explicit positive cap", () => {
      const capped = { ...base, maxAmountPerTx: 100 };
      assert.doesNotThrow(() => checkAuthorization(capped, "withdraw", 100));
      assert.doesNotThrow(() => checkAuthorization(capped, "withdraw", 1));
    });
    it("denies an amount over an explicit cap", () => {
      const capped = { ...base, maxAmountPerTx: 100 };
      assert.throws(() => checkAuthorization(capped, "withdraw", 101), /exceeds/);
    });
  });
});
