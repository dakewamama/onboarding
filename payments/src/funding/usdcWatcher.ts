import * as fs from "fs";
import * as path from "path";
import {
  Connection,
  PublicKey,
  ParsedTransactionWithMeta,
  TokenBalance,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { FundingConfig } from "./config";
import type { CreditRecord } from "./depositLedger";
import type { MoneyLedger } from "./moneyLedger";

/**
 * Watches the chain for USDC arriving at each user's Axis wallet and credits the
 * balance ONLY after the deposit reaches the configured commitment on-chain —
 * never on any client's say-so. This is the crypto-funding analogue of the Paj
 * webhook handler's discipline: parse a real terminal signal, then credit exactly
 * once via the durable, signature-keyed ledger.
 *
 * The watchlist and each owner's scan cursor are persisted, so after a restart
 * the next poll reads everything since the cursor and credits (idempotently)
 * any deposit that landed while the service was down.
 */
export class UsdcWatcher {
  private connection: Connection;
  private mint: PublicKey;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private watchDir: string;
  // Rate-limit backoff: when the RPC 429s, pause polling and grow the pause
  // (capped), so a throttled RPC never turns into a request/log storm.
  private cooldownUntil = 0;
  private backoffMs = 0;
  private static readonly BASE_BACKOFF_MS = 30_000;
  private static readonly MAX_BACKOFF_MS = 300_000;
  /** Pages of new signatures read per owner per poll. */
  private static readonly MAX_PAGES = 20;

  constructor(
    private cfg: FundingConfig,
    private ledger: Pick<MoneyLedger, "credit" | "hasCredited">,
    private onCredit: (r: CreditRecord) => void | Promise<void> = () => {},
    connection?: Connection
  ) {
    this.connection =
      connection ??
      // disableRetryOnRateLimit: web3.js otherwise retries every 429 five times,
      // which multiplies load on an already-throttled RPC. We do our own backoff.
      new Connection(cfg.rpcUrl, {
        commitment: cfg.commitment,
        disableRetryOnRateLimit: true,
      });
    this.mint = new PublicKey(cfg.usdcMint);
    this.watchDir = path.join(cfg.storeDir, "watch");
    fs.mkdirSync(this.watchDir, { recursive: true });
  }

  /** The USDC associated-token account a deposit to `owner` lands in. */
  depositAta(owner: string): PublicKey {
    return getAssociatedTokenAddressSync(this.mint, new PublicKey(owner));
  }

  /** Persist an owner into the watchlist so it survives restarts. Idempotent. */
  watch(owner: string): void {
    new PublicKey(owner); // only real public keys are persisted
    const file = this.watchFile(owner);
    if (!fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify({ owner, at: new Date().toISOString() }, null, 2));
    }
  }

  private watchFile(owner: string): string {
    return path.join(this.watchDir, `${safe(owner)}.json`);
  }

  private watchedOwners(): string[] {
    return fs
      .readdirSync(this.watchDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.watchDir, f), "utf8")).owner);
  }

  /** Newest signature on the owner's deposit account that is fully handled. */
  private cursor(owner: string): string | undefined {
    const file = this.watchFile(owner);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")).cursor as string | undefined) : undefined;
  }

  private saveCursor(owner: string, cursor: string): void {
    const file = this.watchFile(owner);
    const record = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { owner, at: new Date().toISOString() };
    fs.writeFileSync(file, JSON.stringify({ ...record, cursor }, null, 2));
  }

  /** Whether an RPC-reported confirmationStatus satisfies our required commitment. */
  private meetsCommitment(status: string | null | undefined): boolean {
    if (this.cfg.commitment === "finalized") return status === "finalized";
    return status === "confirmed" || status === "finalized";
  }

  /**
   * Net USDC base units credited to `owner`'s account in this transaction,
   * computed from the pre/post token-balance snapshots the RPC returns. Using the
   * balance delta (not instruction decoding) captures plain transfers,
   * transferChecked, and CPI transfers alike.
   */
  private incomingBaseUnits(tx: ParsedTransactionWithMeta, owner: string): bigint {
    const mint = this.cfg.usdcMint;
    const match = (b: TokenBalance) => b.mint === mint && b.owner === owner;
    const pre = tx.meta?.preTokenBalances?.find(match);
    const post = tx.meta?.postTokenBalances?.find(match);
    const before = pre ? BigInt(pre.uiTokenAmount.amount) : BigInt(0);
    const after = post ? BigInt(post.uiTokenAmount.amount) : BigInt(0);
    const delta = after - before;
    return delta > BigInt(0) ? delta : BigInt(0);
  }

  /**
   * One scan of one owner's deposit account: every signature since the cursor,
   * page by page, so a busy account (deposits plus outgoing transfers) never
   * pushes a deposit out of view. Signatures are handled oldest first; the
   * cursor only advances over ones that are settled one way or the other, so a
   * deposit still short of the required commitment is looked at again next poll.
   */
  async scanOwner(owner: string): Promise<void> {
    const ata = this.depositAta(owner);
    const until = this.cursor(owner);
    const newestFirst: { signature: string; err: unknown; confirmationStatus?: string | null }[] = [];
    let before: string | undefined;
    let complete = false;
    for (let page = 0; page < UsdcWatcher.MAX_PAGES; page++) {
      const sigs = await this.connection.getSignaturesForAddress(ata, {
        limit: this.cfg.pageSize,
        ...(until ? { until } : {}),
        ...(before ? { before } : {}),
      });
      newestFirst.push(...sigs);
      if (sigs.length < this.cfg.pageSize) { complete = true; break; }
      before = sigs[sigs.length - 1].signature;
    }
    if (!complete) {
      console.warn(`[funding] ${owner}: more than ${UsdcWatcher.MAX_PAGES} pages of new activity; cursor held until it is all seen`);
    }

    let advance = complete; // a gap behind an unseen page must not be skipped
    for (const info of newestFirst.reverse()) {
      const handled = await this.handleSignature(owner, info);
      if (!handled) advance = false;
      if (advance) this.saveCursor(owner, info.signature);
    }
  }

  /** True once the signature needs no further look: failed, not a deposit, or credited. */
  private async handleSignature(owner: string, info: { signature: string; err: unknown; confirmationStatus?: string | null }): Promise<boolean> {
    if (info.err) return true; // failed tx moved no funds
    if (!this.meetsCommitment(info.confirmationStatus)) return false;
    if (await this.ledger.hasCredited(owner, info.signature)) return true;

    const tx = await this.connection.getParsedTransaction(info.signature, {
      commitment: this.cfg.commitment,
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return false; // not visible at this commitment yet
    if (tx.meta?.err) return true;

    const baseUnits = this.incomingBaseUnits(tx, owner);
    if (baseUnits <= BigInt(0)) return true; // not an incoming USDC transfer

    const fresh = await this.ledger.credit({
      signature: info.signature,
      owner,
      baseUnits: baseUnits.toString(),
      commitment: this.cfg.commitment,
    });
    if (fresh) {
      await this.onCredit({
        signature: info.signature,
        owner,
        baseUnits: baseUnits.toString(),
        commitment: this.cfg.commitment,
        at: new Date().toISOString(),
      });
    }
    return true;
  }

  /** One full poll across every watched owner. Single-flight, with RPC backoff. */
  async pollOnce(): Promise<void> {
    if (this.polling) return;
    if (Date.now() < this.cooldownUntil) return; // in backoff, skip this tick
    this.polling = true;
    let rateLimited = false;
    try {
      for (const owner of this.watchedOwners()) {
        try {
          await this.scanOwner(owner);
        } catch (err) {
          const msg = (err as Error).message;
          if (isRateLimit(msg)) {
            rateLimited = true;
            break; // stop hitting a throttled RPC; back off below
          }
          console.error(`[funding] scan failed for ${owner}:`, msg);
        }
      }
    } finally {
      this.polling = false;
      if (rateLimited) {
        this.backoffMs = this.backoffMs
          ? Math.min(this.backoffMs * 2, UsdcWatcher.MAX_BACKOFF_MS)
          : UsdcWatcher.BASE_BACKOFF_MS;
        this.cooldownUntil = Date.now() + this.backoffMs;
        console.warn(
          `[funding] RPC rate-limited; pausing deposit scans for ${Math.round(
            this.backoffMs / 1000
          )}s (consider a dedicated SOLANA_RPC_URL)`
        );
      } else {
        this.backoffMs = 0; // clean poll, reset backoff
      }
    }
  }

  start(): void {
    if (this.timer) return;
    void this.pollOnce();
    this.timer = setInterval(() => void this.pollOnce(), this.cfg.pollIntervalMs);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

function safe(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function isRateLimit(message: string): boolean {
  return /429|too many requests|rate limit/i.test(message);
}
