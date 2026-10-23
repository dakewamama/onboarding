import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair } from "@solana/web3.js";
import { UsdcWatcher } from "../payments/src/funding/usdcWatcher";
import type { FundingConfig } from "../payments/src/funding/config";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type Sig = { signature: string; err: null; confirmationStatus: "finalized" | "processed"; amount: number };

/** A deposit account's history, newest first, served the way the RPC pages it. */
function fakeChain(owner: string, history: Sig[]) {
  return {
    async getSignaturesForAddress(_ata: unknown, o: { limit: number; until?: string; before?: string }) {
      let list = history;
      if (o.until) list = list.slice(0, list.findIndex((s) => s.signature === o.until));
      if (o.before) list = list.slice(list.findIndex((s) => s.signature === o.before) + 1);
      return list.slice(0, o.limit).map(({ signature, err, confirmationStatus }) => ({ signature, err, confirmationStatus }));
    },
    async getParsedTransaction(signature: string) {
      const s = history.find((h) => h.signature === signature)!;
      const bal = (amount: number) => [{ mint: MINT, owner, accountIndex: 0, uiTokenAmount: { amount: String(amount) } }];
      // Outgoing transfers (amount < 0) lower the balance; deposits raise it.
      return { meta: { err: null, preTokenBalances: bal(1_000_000), postTokenBalances: bal(1_000_000 + s.amount) } };
    },
  };
}

describe("USDC deposit watcher", () => {
  it("credits every deposit since the cursor across pages, and waits for unconfirmed ones", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watcher-"));
    const cfg: FundingConfig = { rpcUrl: "http://unused", usdcMint: MINT, commitment: "finalized", pollIntervalMs: 60000, pageSize: 10, storeDir: dir };
    // 25 signatures, newest first: every 3rd is a deposit, the rest outgoing; the newest deposit is not final yet.
    const history: Sig[] = Array.from({ length: 25 }, (_, i) => ({
      signature: `sig${24 - i}`,
      err: null,
      confirmationStatus: i === 3 ? "processed" : "finalized",
      amount: (24 - i) % 3 === 0 ? 100 + (24 - i) : -5,
    }));
    const credited = new Map<string, string>();
    const ledger = {
      async hasCredited(_o: string, sig: string) { return credited.has(sig); },
      async credit(r: { signature: string; baseUnits: string }) { if (credited.has(r.signature)) return false; credited.set(r.signature, r.baseUnits); return true; },
    };
    const chain = fakeChain(owner, history);
    const watcher = new UsdcWatcher(cfg, ledger, () => {}, chain as never);
    watcher.watch(owner);

    await watcher.scanOwner(owner);
    const deposits = history.filter((s) => s.amount > 0);
    const final = deposits.filter((s) => s.confirmationStatus === "finalized").map((s) => s.signature).sort();
    assert.deepEqual([...credited.keys()].sort(), final, "every final deposit beyond the first page is credited");
    const cursor = () => JSON.parse(fs.readdirSync(path.join(dir, "watch")).map((f) => fs.readFileSync(path.join(dir, "watch", f), "utf8"))[0]).cursor;
    assert.equal(cursor(), "sig20", "cursor stops just before the unconfirmed signature");

    // It finalizes; the next poll credits it from the cursor.
    history[3].confirmationStatus = "finalized";
    await watcher.scanOwner(owner);
    assert.isTrue(credited.has("sig21"));
    assert.equal(cursor(), "sig24");
    assert.equal(credited.size, final.length + 1);
  });
});
