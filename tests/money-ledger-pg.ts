import { assert } from "chai";
import { randomUUID } from "crypto";
import { Pool } from "pg";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileMoneyLedger, PostgresMoneyLedger, SpendKeyVoidedError } from "../payments/src/funding/moneyLedger";
import { PostgresTransferStore, importTransferFiles } from "../payments/src/funding/transferStore";
import { InsufficientBalanceError } from "../payments/src/funding/spendLedger";

const url = process.env.TEST_DATABASE_URL;
const u = (n: number) => BigInt(n);

describe("Axis Money Postgres ledger", function () {
  if (!url) {
    it.skip("requires TEST_DATABASE_URL (run: yarn test:money)");
    return;
  }
  const schema = `money_test_${randomUUID().replace(/-/g, "")}`;
  const pools: Pool[] = [];
  const open = () => {
    const pool = new Pool({ connectionString: url, max: 10, options: `-c search_path=${schema}` });
    pools.push(pool);
    return new PostgresMoneyLedger(pool);
  };
  let a: PostgresMoneyLedger;
  let b: PostgresMoneyLedger;

  before(async () => {
    const admin = new Pool({ connectionString: url });
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.end();
    a = open();
    b = open(); // a second process sharing the same database
    await Promise.all([a.migrate(), b.migrate()]);
  });
  after(async () => {
    await Promise.all(pools.map(p => p.end()));
    const admin = new Pool({ connectionString: url });
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  const credit = (ledger: PostgresMoneyLedger, owner: string, signature: string, units: number) =>
    ledger.credit({ owner, signature, baseUnits: String(units), commitment: "finalized" });

  it("credits a deposit exactly once across processes", async () => {
    const results = await Promise.all([credit(a, "dep", "sig", 100), credit(b, "dep", "sig", 100), credit(a, "dep", "sig", 999)]);
    assert.deepEqual(results.filter(Boolean).length, 1);
    assert.equal((await a.availableBaseUnits("dep")).toString(), "100");
    assert.isTrue(await b.hasCredited("dep", "sig"));
    assert.isFalse(await credit(a, "dep", "zero", 0));
  });

  it("a custody reserve is created IN_DOUBT in the same write, never held without a state", async () => {
    const owner = `owner-${randomUUID()}`;
    await a.credit({ signature: `sig-${randomUUID()}`, owner, baseUnits: "1000", commitment: "finalized" });
    const r = await a.spend({ owner, idempotencyKey: "custody-1", paidBaseUnits: u(400), costBaseUnits: u(400), reason: "merchant custody transfer", provider: "custody", requestFingerprint: "f" });
    assert.equal(r.record.state, "IN_DOUBT");
    assert.equal((await b.get(owner, "custody-1"))?.state, "IN_DOUBT");
    assert.equal((await a.availableBaseUnits(owner)).toString(), "600");
    assert.deepEqual((await b.spends(owner)).map(r => [r.idempotencyKey, r.paidBaseUnits, r.state]), [["custody-1", "400", "IN_DOUBT"]]);
  });

  it("concurrent spends from two processes cannot overdraw", async () => {
    await credit(a, "race", "sig", 100);
    const attempts = Array.from({ length: 10 }, (_, i) =>
      (i % 2 ? a : b).spend({ owner: "race", idempotencyKey: `k${i}`, paidBaseUnits: u(30), costBaseUnits: u(28), reason: "test" }));
    const settled = await Promise.allSettled(attempts);
    const ok = settled.filter(s => s.status === "fulfilled");
    const refused = settled.filter(s => s.status === "rejected");
    assert.equal(ok.length, 3);
    assert.isTrue(refused.every(r => (r as PromiseRejectedResult).reason instanceof InsufficientBalanceError));
    assert.equal((await a.availableBaseUnits("race")).toString(), "10");
    assert.equal((await b.spentBaseUnits("race")).toString(), "90");
  });

  it("one idempotency key debits once even when replayed concurrently", async () => {
    await credit(a, "dup", "sig", 100);
    const input = { owner: "dup", idempotencyKey: "same", paidBaseUnits: u(40), costBaseUnits: u(40), reason: "test" };
    const results = await Promise.all([a.spend(input), b.spend(input), a.spend(input)]);
    assert.equal(results.filter(r => r.applied).length, 1);
    assert.equal((await a.availableBaseUnits("dup")).toString(), "60");
  });

  it("release returns funds, settlement books provider cost and pool gain, terminal states never move", async () => {
    await credit(a, "life", "sig", 1000);
    await a.spend({ owner: "life", idempotencyKey: "rel", paidBaseUnits: u(100), costBaseUnits: u(90), reason: "airtime", provider: "vtpass" });
    await a.spend({ owner: "life", idempotencyKey: "set", paidBaseUnits: u(200), costBaseUnits: u(150), reason: "airtime", provider: "vtpass" });
    assert.equal((await a.get("life", "rel"))?.state, "IN_DOUBT");
    assert.equal((await a.availableBaseUnits("life")).toString(), "700");
    await b.setState("life", "rel", "RELEASED");
    await Promise.all([a.setState("life", "set", "SETTLED"), b.setState("life", "set", "SETTLED")]);
    assert.equal((await a.availableBaseUnits("life")).toString(), "800");
    for (const late of ["IN_DOUBT", "PENDING", "SETTLED"] as const) assert.equal((await a.setState("life", "rel", late)).state, "RELEASED");
    assert.equal((await a.setState("life", "set", "RELEASED")).state, "SETTLED");
    assert.equal((await a.availableBaseUnits("life")).toString(), "800");
    const balances = await a.pool.query("SELECT account, SUM(amount)::text AS v FROM money_postings WHERE account LIKE 'user:life:%' OR account IN ('provider:vtpass','axis:pool_gain') GROUP BY account ORDER BY account");
    assert.deepEqual(Object.fromEntries(balances.rows.map(r => [r.account, r.v])), {
      "axis:pool_gain": "50", "provider:vtpass": "150", "user:life:available": "800", "user:life:held": "0",
    });
  });

  it("every transaction balances and entries are immutable", async () => {
    const totals = await a.pool.query("SELECT transaction_id FROM money_postings GROUP BY transaction_id, asset HAVING SUM(amount) <> 0");
    assert.equal(totals.rowCount, 0);
    let error: unknown;
    try { await a.pool.query("UPDATE money_postings SET amount = amount * 2"); } catch (e) { error = e; }
    assert.match(String(error), /immutable/);
    error = undefined;
    try { await a.pool.query("DELETE FROM money_transactions"); } catch (e) { error = e; }
    assert.match(String(error), /immutable/);
    const db = await a.pool.connect();
    try {
      await db.query("BEGIN");
      const tx = await db.query("INSERT INTO money_transactions(key,kind,owner) VALUES ($1,'deposit','x') RETURNING id", [randomUUID()]);
      await db.query("INSERT INTO money_postings(transaction_id,account,asset,amount) VALUES ($1,'user:x:available','USDC',5)", [tx.rows[0].id]);
      error = undefined;
      try { await db.query("COMMIT"); } catch (e) { error = e; }
      assert.match(String(error), /unbalanced/);
    } finally {
      await db.query("ROLLBACK").catch(() => undefined);
      db.release();
    }
  });

  it("available always equals deposits minus active spends", async () => {
    for (const owner of ["race", "dup", "life"]) {
      const deposits = (await a.deposits(owner)).reduce((s, d) => s + BigInt(d.baseUnits), u(0));
      assert.equal((await a.availableBaseUnits(owner)).toString(), (deposits - (await a.spentBaseUnits(owner))).toString(), owner);
    }
  });

  it("imports the legacy file ledger once, preserving balances, states and timestamps", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "money-import-"));
    const files = new FileMoneyLedger(dir);
    await files.credit({ owner: "legacy", signature: "s1", baseUnits: "1000", commitment: "finalized" });
    await files.credit({ owner: "legacy", signature: "s2:sol", baseUnits: "500", commitment: "finalized", asset: "sol", lamports: "1", priceUsdcPerSol: 150 });
    await files.spend({ owner: "legacy", idempotencyKey: "settled", paidBaseUnits: u(200), costBaseUnits: u(180), reason: "airtime", provider: "vtpass" });
    await files.setState("legacy", "settled", "SETTLED");
    await files.spend({ owner: "legacy", idempotencyKey: "released", paidBaseUnits: u(300), costBaseUnits: u(300), reason: "airtime", provider: "vtpass" });
    await files.setState("legacy", "released", "RELEASED");
    await files.spend({ owner: "legacy", idempotencyKey: "doubt", paidBaseUnits: u(100), costBaseUnits: u(90), reason: "airtime", provider: "vtpass" });
    await files.spend({ owner: "legacy", idempotencyKey: "transfer", paidBaseUnits: u(50), costBaseUnits: u(50), reason: "custody" });
    const first = await a.importFileLedger(dir);
    assert.deepInclude(first, { deposits: 2, spends: 4, negativeOwners: [] });
    assert.deepInclude(await b.importFileLedger(dir), { deposits: 0, spends: 0 });
    assert.equal((await a.availableBaseUnits("legacy")).toString(), (await files.availableBaseUnits("legacy")).toString());
    assert.equal((await a.availableBaseUnits("legacy")).toString(), "1150");
    for (const key of ["settled", "released", "doubt", "transfer"]) {
      const before = (await files.get("legacy", key))!, after = (await a.get("legacy", key))!;
      assert.equal(after.at, before.at, key);
      assert.equal(after.state, before.state, key);
    }
  });

  it("voiding an unknown key and a debit under it race to exactly one winner", async () => {
    await credit(a, "void", "sig", 1000);
    for (let i = 0; i < 20; i++) {
      const key = `race-${i}`;
      const [spent, voided] = await Promise.allSettled([
        a.spend({ owner: "void", idempotencyKey: key, paidBaseUnits: u(1), costBaseUnits: u(1), reason: "t" }),
        b.voidUnknownKey(key, "not_submitted"),
      ]);
      const debited = spent.status === "fulfilled";
      if (!debited) assert.instanceOf((spent as PromiseRejectedResult).reason, SpendKeyVoidedError);
      // A void that lost the race must report the debit it found, never "not submitted".
      assert.equal(voided.status === "fulfilled" && voided.value !== null, debited, key);
    }
    const spends = await a.pool.query("SELECT count(*)::int AS n FROM money_spends WHERE owner='void'");
    const voids = await a.pool.query("SELECT count(*)::int AS n FROM money_voided_keys WHERE idempotency_key LIKE 'race-%'");
    assert.equal(spends.rows[0].n + voids.rows[0].n, 20);
  });

  it("custody transfer records claim once and compare-and-set across processes", async () => {
    type R = { idempotencyKey: string; status: string; signature?: string; updatedAt: string };
    const one = new PostgresTransferStore<R>(a), two = new PostgresTransferStore<R>(b);
    const base: R = { idempotencyKey: "t1", status: "in_doubt", updatedAt: new Date().toISOString() };
    const claims = await Promise.all([one.claim(base), two.claim(base)]);
    assert.equal(claims.filter(c => c.inserted).length, 1);
    const unsigned = (r: R) => !r.signature && r.status !== "failed";
    const [signed, abandoned] = await Promise.all([
      one.update({ ...base, signature: "sig" }, unsigned),
      two.update({ ...base, status: "failed" }, unsigned),
    ]);
    assert.notEqual(signed, abandoned, "exactly one writer wins");
    const stored = (await one.read("t1"))!;
    assert.equal(stored.signature === "sig", signed);
  });

  it("imports legacy custody transfer files once", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-import-"));
    fs.mkdirSync(path.join(dir, "custody-transfers"));
    fs.writeFileSync(path.join(dir, "custody-transfers", "x.json"), JSON.stringify({ idempotencyKey: "legacy-t", status: "settled", signature: "s", updatedAt: "2026-01-01T00:00:00.000Z" }));
    assert.equal(await importTransferFiles(a, dir), 1);
    assert.equal(await importTransferFiles(b, dir), 0);
    assert.equal((await new PostgresTransferStore(a).read("legacy-t"))?.status, "settled");
  });

  it("ambiguous keys across owners fail closed", async () => {
    await credit(a, "o1", "s", 10); await credit(a, "o2", "s", 10);
    await a.spend({ owner: "o1", idempotencyKey: "shared", paidBaseUnits: u(1), costBaseUnits: u(1), reason: "t" });
    await a.spend({ owner: "o2", idempotencyKey: "shared", paidBaseUnits: u(1), costBaseUnits: u(1), reason: "t" });
    let error: unknown;
    try { await a.findByKey("shared"); } catch (e) { error = e; }
    assert.match(String(error), /ambiguous/);
  });
});
