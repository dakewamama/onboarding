import * as fs from "fs";
import * as path from "path";
import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";
import { FundingConfig } from "./config";
import type { CreditRecord } from "./depositLedger";
import type { MoneyLedger } from "./moneyLedger";
import { solUsdcPrice } from "./solPrice";

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Watches for NATIVE SOL arriving at each user's Axis wallet and credits the
 * USDC-equivalent, ONLY after the deposit reaches the configured commitment —
 * the same discipline as the USDC watcher. SOL is valued at a live SOL->USDC
 * price at credit time (see solPrice.ts); if the price can't be fetched we skip
 * crediting this poll and retry, never crediting a wrong amount.
 *
 * We reuse the USDC watcher's persisted watchlist (`<storeDir>/watch`), so every
 * armed wallet is watched for both assets with no extra wiring. Credits are keyed
 * `<signature>:sol` in the shared DepositLedger, so a SOL credit can never collide
 * with a USDC credit for the same transaction.
 */
export class SolWatcher {
  private connection: Connection;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private watchDir: string;
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
    connection?: Connection,
    private price: () => Promise<number> = () => solUsdcPrice(),
  ) {
    this.connection =
      connection ??
      new Connection(cfg.rpcUrl, {
        commitment: cfg.commitment,
        disableRetryOnRateLimit: true,
      });
    this.watchDir = path.join(cfg.storeDir, "watch");
    fs.mkdirSync(this.watchDir, { recursive: true });
  }

  private watchedOwners(): string[] {
    if (!fs.existsSync(this.watchDir)) return [];
    return fs
      .readdirSync(this.watchDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(this.watchDir, f), "utf8")).owner);
  }

  private meetsCommitment(status: string | null | undefined): boolean {
    if (this.cfg.commitment === "finalized") return status === "finalized";
    return status === "confirmed" || status === "finalized";
  }

  /**
   * Net lamports credited to `owner` in this tx: the owner's native balance
   * delta, but only when the owner is NOT a signer (a pure recipient). This skips
   * the owner's own outbound/self transactions and fee spends.
   */
  private incomingLamports(tx: ParsedTransactionWithMeta, owner: string): bigint {
    const keys = tx.transaction.message.accountKeys;
    const idx = keys.findIndex((k) => k.pubkey.toBase58() === owner);
    if (idx < 0) return BigInt(0);
    if (keys[idx].signer) return BigInt(0); // owner initiated it — not a deposit
    const pre = tx.meta?.preBalances?.[idx];
    const post = tx.meta?.postBalances?.[idx];
    if (pre == null || post == null) return BigInt(0);
    const delta = BigInt(post) - BigInt(pre);
    return delta > BigInt(0) ? delta : BigInt(0);
  }

  /** Value lamports as integer USDC base units (6dp), rounded DOWN, in exact integer math. */
  private toUsdcBase(lamports: bigint, priceUsdcPerSol: number): bigint {
    const priceMicro = BigInt(Math.round(priceUsdcPerSol * 1_000_000));
    return (lamports * priceMicro) / BigInt(1_000_000_000);
  }

  /** This watcher's own cursor file, apart from the USDC watcher's, so neither overwrites the other. */
  private cursorFile(owner: string): string {
    return path.join(this.cfg.storeDir, "sol-cursor", `${owner.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);
  }

  /** Newest signature on the wallet fully handled by this watcher. */
  private cursor(owner: string): string | undefined {
    const file = this.cursorFile(owner);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")).cursor as string | undefined) : undefined;
  }

  private saveCursor(owner: string, cursor: string): void {
    const file = this.cursorFile(owner);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ owner, cursor }, null, 2));
  }

  /**
   * Every signature on the wallet since the cursor, page by page, handled oldest
   * first. The cursor only advances over signatures that are settled one way or
   * the other, so a deposit short of commitment, or one waiting on a price, is
   * looked at again next poll.
   */
  async scanOwner(owner: string): Promise<void> {
    const pubkey = new PublicKey(owner);
    const until = this.cursor(owner);
    const newestFirst: { signature: string; err: unknown; confirmationStatus?: string | null }[] = [];
    let before: string | undefined;
    let complete = false;
    for (let page = 0; page < SolWatcher.MAX_PAGES; page++) {
      const sigs = await this.connection.getSignaturesForAddress(pubkey, {
        limit: this.cfg.pageSize,
        ...(until ? { until } : {}),
        ...(before ? { before } : {}),
      });
      newestFirst.push(...sigs);
      if (sigs.length < this.cfg.pageSize) { complete = true; break; }
      before = sigs[sigs.length - 1].signature;
    }
    if (!complete) {
      console.warn(`[funding] ${owner}: more than ${SolWatcher.MAX_PAGES} pages of new activity; SOL cursor held until it is all seen`);
    }

    let advance = complete;
    for (const info of newestFirst.reverse()) {
      if (!(await this.handleSignature(owner, info))) advance = false;
      if (advance) this.saveCursor(owner, info.signature);
    }
  }

  /** True once the signature needs no further look: failed, not a SOL deposit, or credited. */
  private async handleSignature(owner: string, info: { signature: string; err: unknown; confirmationStatus?: string | null }): Promise<boolean> {
    if (info.err) return true;
    if (!this.meetsCommitment(info.confirmationStatus)) return false;
    const key = `${info.signature}:sol`;
    if (await this.ledger.hasCredited(owner, key)) return true;

    const tx = await this.connection.getParsedTransaction(info.signature, {
      commitment: this.cfg.commitment,
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) return false;
    if (tx.meta?.err) return true;

    const lamports = this.incomingLamports(tx, owner);
    if (lamports <= BigInt(0)) return true;

    // Price at credit time. Fail-closed: on any error, retry next poll.
    let price: number;
    try {
      price = await this.price();
    } catch (err) {
      console.warn(
        `[funding] SOL price unavailable; deferring credit of ${info.signature}:`,
        (err as Error).message,
      );
      return false;
    }

    const baseUnits = this.toUsdcBase(lamports, price);
    if (baseUnits <= BigInt(0)) return true;

    const fresh = await this.ledger.credit({
      signature: key,
      owner,
      baseUnits: baseUnits.toString(),
      commitment: this.cfg.commitment,
      asset: "sol",
      lamports: lamports.toString(),
      priceUsdcPerSol: price,
    });
    if (fresh) {
      await this.onCredit({
        signature: key,
        owner,
        baseUnits: baseUnits.toString(),
        commitment: this.cfg.commitment,
        at: new Date().toISOString(),
        asset: "sol",
        lamports: lamports.toString(),
        priceUsdcPerSol: price,
      });
    }
    return true;
  }

  async pollOnce(): Promise<void> {
    if (this.polling) return;
    if (Date.now() < this.cooldownUntil) return;
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
            break;
          }
          console.error(`[funding] SOL scan failed for ${owner}:`, msg);
        }
      }
    } finally {
      this.polling = false;
      if (rateLimited) {
        this.backoffMs = this.backoffMs
          ? Math.min(this.backoffMs * 2, SolWatcher.MAX_BACKOFF_MS)
          : SolWatcher.BASE_BACKOFF_MS;
        this.cooldownUntil = Date.now() + this.backoffMs;
        console.warn(
          `[funding] RPC rate-limited (SOL); pausing scans for ${Math.round(
            this.backoffMs / 1000,
          )}s`,
        );
      } else {
        this.backoffMs = 0;
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

function isRateLimit(message: string): boolean {
  return /429|too many requests|rate limit/i.test(message);
}
