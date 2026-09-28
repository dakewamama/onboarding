import * as fs from "fs";
import * as path from "path";
import { Connection, PublicKey, ParsedTransactionWithMeta } from "@solana/web3.js";
import { FundingConfig } from "./config";
import { DepositLedger, CreditRecord } from "./depositLedger";
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

  constructor(
    private cfg: FundingConfig,
    private ledger: DepositLedger,
    private onCredit: (r: CreditRecord) => void | Promise<void> = () => {},
    connection?: Connection,
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

  /** Value lamports as integer USDC base units (6dp), rounded DOWN. */
  private toUsdcBase(lamports: bigint, priceUsdcPerSol: number): bigint {
    // usdcBase = floor(lamports/1e9 * price * 1e6) = floor(lamports * price / 1000)
    const micro = (Number(lamports) * priceUsdcPerSol) / 1000;
    return BigInt(Math.floor(micro));
  }

  async scanOwner(owner: string): Promise<void> {
    const pubkey = new PublicKey(owner);
    const sigs = await this.connection.getSignaturesForAddress(pubkey, {
      limit: this.cfg.pageSize,
    });

    for (const info of sigs) {
      if (info.err) continue;
      if (!this.meetsCommitment(info.confirmationStatus)) continue;
      const key = `${info.signature}:sol`;
      if (this.ledger.hasCredited(owner, key)) continue;

      const tx = await this.connection.getParsedTransaction(info.signature, {
        commitment: this.cfg.commitment,
        maxSupportedTransactionVersion: 0,
      });
      if (!tx || tx.meta?.err) continue;

      const lamports = this.incomingLamports(tx, owner);
      if (lamports <= BigInt(0)) continue;

      // Price at credit time. Fail-closed: on any error, skip and retry next poll.
      let price: number;
      try {
        price = await solUsdcPrice();
      } catch (err) {
        console.warn(
          `[funding] SOL price unavailable; deferring credit of ${info.signature}:`,
          (err as Error).message,
        );
        continue;
      }

      const baseUnits = this.toUsdcBase(lamports, price);
      if (baseUnits <= BigInt(0)) continue;

      const fresh = this.ledger.credit({
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
    }
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
