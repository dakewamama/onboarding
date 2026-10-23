import { assert } from "chai";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import { SolWatcher } from "../payments/src/funding/solWatcher";
import type { FundingConfig } from "../payments/src/funding/config";

type Sig = { signature: string; err: null; confirmationStatus: "finalized"; lamports: number; ownerSigned: boolean };

/** A wallet's history, newest first, paged the way the RPC pages it. */
function fakeChain(owner: string, history: Sig[]) {
  return {
    async getSignaturesForAddress(_a: unknown, o: { limit: number; until?: string; before?: string }) {
      let list = history;
      if (o.until) list = list.slice(0, list.findIndex((s) => s.signature === o.until));
      if (o.before) list = list.slice(list.findIndex((s) => s.signature === o.before) + 1);
      return list.slice(0, o.limit).map(({ signature, err, confirmationStatus }) => ({ signature, err, confirmationStatus }));
    },
    async getParsedTransaction(signature: string) {
      const s = history.find((h) => h.signature === signature)!;
      return {
        transaction: { message: { accountKeys: [{ pubkey: new PublicKey(owner), signer: s.ownerSigned }] } },
        meta: { err: null, preBalances: [5_000_000_000], postBalances: [5_000_000_000 + s.lamports] },
      };
    },
  };
}

describe("SOL deposit watcher", () => {
  it("credits every SOL deposit since the cursor across pages, ignores the owner's own payouts, and waits for a price", async () => {
    const owner = Keypair.generate().publicKey.toBase58();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sol-watcher-"));
    const cfg: FundingConfig = { rpcUrl: "http://unused", usdcMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", commitment: "finalized", pollIntervalMs: 60000, pageSize: 10, storeDir: dir };
    // 25 signatures, newest first: every 4th is a deposit (0.1 SOL); the rest are the owner's own payouts.
    const history: Sig[] = Array.from({ length: 25 }, (_, i) => {
      const n = 24 - i, deposit = n % 4 === 0;
      return { signature: `sig${n}`, err: null, confirmationStatus: "finalized", lamports: deposit ? 100_000_000 : -50_000_000, ownerSigned: !deposit };
    });
    const credited = new Map<string, string>();
    const ledger = {
      async hasCredited(_o: string, sig: string) { return credited.has(sig); },
      async credit(r: { signature: string; baseUnits: string }) { if (credited.has(r.signature)) return false; credited.set(r.signature, r.baseUnits); return true; },
    };
    let priceUp = false;
    const watcher = new SolWatcher(cfg, ledger, () => {}, fakeChain(owner, history) as never, async () => {
      if (!priceUp) throw new Error("price feed down");
      return 150.25;
    });

    await watcher.scanOwner(owner);
    assert.equal(credited.size, 0, "nothing is credited without a price");

    priceUp = true;
    await watcher.scanOwner(owner);
    const deposits = history.filter((s) => !s.ownerSigned).map((s) => `${s.signature}:sol`).sort();
    assert.deepEqual([...credited.keys()].sort(), deposits, "every deposit beyond the first page; no payout counted");
    assert.equal(credited.get("sig0:sol"), "15025000", "0.1 SOL at 150.25 USDC, exact integer math");
    const cursor = JSON.parse(fs.readFileSync(path.join(dir, "sol-cursor", `${owner}.json`), "utf8")).cursor;
    assert.equal(cursor, "sig24");
  });
});
