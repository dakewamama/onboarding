import { assert } from "chai";
import { PajClient } from "../payments/src/pajClient";

describe("PajClient.registerBankAccount (the correct v2 primitive)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("POSTs /pub/v2/bank-account with x-api-key and returns the permanent address", async () => {
    let captured: { url: string; init: any } = { url: "", init: null };
    globalThis.fetch = (async (url: string, init: any) => {
      captured = { url, init };
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            id: "acc_1",
            accountName: "John Doe",
            accountNumber: "0025635480",
            bank: "First Bank",
            address: "FsXpXq8wVTM13NDXxrf2PpgJWg9jCxRVuHhtfnojUa",
          }),
      } as Response;
    }) as typeof fetch;

    const client = new PajClient({ apiKey: "KEY", env: "production" });
    const acct = await client.registerBankAccount({
      bankCode: "000016",
      accountNumber: "0025635480",
    });

    assert.equal(captured.url, "https://api.paj.cash/pub/v2/bank-account");
    assert.equal(captured.init.method, "POST");
    assert.equal(captured.init.headers["x-api-key"], "KEY");
    const body = JSON.parse(captured.init.body);
    assert.equal(body.bankCode, "000016");
    assert.equal(body.accountNumber, "0025635480");
    assert.equal(acct.address, "FsXpXq8wVTM13NDXxrf2PpgJWg9jCxRVuHhtfnojUa");
    assert.equal(acct.accountName, "John Doe");
  });

  it("throws (never silently succeeds) on a non-2xx from Paj", async () => {
    globalThis.fetch = (async () =>
      ({ ok: false, status: 400, text: async () => "bad request" }) as Response) as typeof fetch;
    const client = new PajClient({ apiKey: "KEY", env: "production" });
    let threw = false;
    try {
      await client.registerBankAccount({ bankCode: "x", accountNumber: "y" });
    } catch {
      threw = true;
    }
    assert.isTrue(threw);
  });
});
