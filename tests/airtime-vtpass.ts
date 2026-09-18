import { assert } from "chai";
import {
  serviceIdFor,
  buildRequestId,
  parseVtpassResult,
  VtpassClient,
} from "../payments/src/vtpassClient";

describe("VTpass airtime rail", () => {
  describe("serviceIdFor", () => {
    it("maps networks, including 9mobile -> etisalat", () => {
      assert.equal(serviceIdFor("MTN"), "mtn");
      assert.equal(serviceIdFor(" glo "), "glo");
      assert.equal(serviceIdFor("airtel"), "airtel");
      assert.equal(serviceIdFor("9mobile"), "etisalat");
      assert.equal(serviceIdFor("9 mobile"), "etisalat");
    });
    it("returns null for an unsupported network", () => {
      assert.isNull(serviceIdFor("smart"));
    });
  });

  describe("buildRequestId", () => {
    it("prefixes with Africa/Lagos (GMT+1) YYYYMMDDHHmm then the suffix", () => {
      const id = buildRequestId(new Date("2025-03-10T09:14:00Z"), "abc123");
      assert.equal(id, "202503101014abc123");
    });
  });

  describe("parseVtpassResult", () => {
    it("delivered + code 000 is success", () => {
      const r = parseVtpassResult({
        code: "000",
        response_description: "TRANSACTION SUCCESSFUL",
        content: { transactions: { status: "delivered", transactionId: "tx1" } },
        requestId: "r1",
      });
      assert.isTrue(r.success);
      assert.equal(r.status, "delivered");
      assert.equal(r.transactionId, "tx1");
    });
    it("pending is not success", () => {
      const r = parseVtpassResult({
        code: "000",
        content: { transactions: { status: "pending" } },
      });
      assert.isFalse(r.success);
      assert.equal(r.status, "pending");
    });
    it("an error code is not success", () => {
      const r = parseVtpassResult({ code: "016", response_description: "FAILED" });
      assert.isFalse(r.success);
      assert.equal(r.code, "016");
    });
  });

  describe("VtpassClient.buyAirtime", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it("posts the right serviceID + headers and parses success", async () => {
      let captured: { url: string; init: any } = { url: "", init: null };
      globalThis.fetch = (async (url: string, init: any) => {
        captured = { url, init };
        return {
          json: async () => ({
            code: "000",
            content: { transactions: { status: "delivered", transactionId: "tx9" } },
            requestId: "r9",
          }),
        } as Response;
      }) as typeof fetch;

      const client = new VtpassClient({
        apiKey: "AK",
        secretKey: "SK",
        env: "sandbox",
      });
      const r = await client.buyAirtime({ network: "mtn", amount: 50, phone: "08011111111" });

      assert.equal(captured.url, "https://sandbox.vtpass.com/api/pay");
      assert.equal(captured.init.headers["api-key"], "AK");
      assert.equal(captured.init.headers["secret-key"], "SK");
      const body = JSON.parse(captured.init.body);
      assert.equal(body.serviceID, "mtn");
      assert.equal(body.amount, 50);
      assert.equal(body.phone, "08011111111");
      assert.isString(body.request_id);
      assert.isTrue(r.success);
    });

    it("rejects an unsupported network and a non-positive amount", async () => {
      const client = new VtpassClient({ apiKey: "AK", secretKey: "SK", env: "sandbox" });
      const rejects = async (p: Promise<unknown>): Promise<boolean> => {
        try {
          await p;
          return false;
        } catch {
          return true;
        }
      };
      assert.isTrue(
        await rejects(client.buyAirtime({ network: "smart", amount: 50, phone: "080" })),
      );
      assert.isTrue(
        await rejects(client.buyAirtime({ network: "mtn", amount: 0, phone: "080" })),
      );
    });
  });
});
