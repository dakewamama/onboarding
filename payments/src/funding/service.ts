import { Connection } from "@solana/web3.js";
import { fromBaseUnits, toBaseUnits } from "../money";
import { FundingConfig, loadFundingConfig } from "./config";
import { DepositLedger, CreditRecord } from "./depositLedger";
import { UsdcWatcher } from "./usdcWatcher";
import { TransferBuilder, BuiltTransfer } from "./transferBuilder";

export interface DepositAddress {
  /** The user's Axis wallet address — where they send USDC. */
  owner: string;
  /** The USDC associated-token account the deposit actually lands in. */
  usdcAta: string;
  /** USDC mint being watched. */
  mint: string;
  /** Solana Pay URI, suitable for rendering as a QR code on the client. */
  qr: string;
  /** Commitment a deposit must reach before it is credited. */
  requiredCommitment: string;
}

/**
 * Facade over the crypto-funding flow: hand a user their deposit address, arm the
 * on-chain watch, and report the durably-credited balance. Credit itself only ever
 * happens inside the watcher, gated on on-chain confirmation.
 */
export class FundingService {
  readonly config: FundingConfig;
  readonly ledger: DepositLedger;
  readonly watcher: UsdcWatcher;
  readonly builder: TransferBuilder;

  constructor(
    config: FundingConfig = loadFundingConfig(),
    onCredit: (r: CreditRecord) => void | Promise<void> = defaultLog
  ) {
    this.config = config;
    this.ledger = new DepositLedger(config.storeDir);
    const connection = new Connection(config.rpcUrl, config.commitment);
    this.watcher = new UsdcWatcher(config, this.ledger, onCredit, connection);
    this.builder = new TransferBuilder(config, connection);
  }

  /** Start the background deposit watcher. */
  start(): void {
    this.watcher.start();
  }

  stop(): void {
    this.watcher.stop();
  }

  /**
   * Issue (idempotently) the deposit address for a user's Axis wallet and arm the
   * watch. The address IS the user's own wallet — Axis never holds their key.
   */
  issueDepositAddress(owner: string): DepositAddress {
    const ata = this.watcher.depositAta(owner);
    this.watcher.watch(owner);
    return {
      owner,
      usdcAta: ata.toBase58(),
      mint: this.config.usdcMint,
      // Solana Pay: send this token to this address. Amount is left open so the
      // user funds any amount from any wallet or exchange.
      qr: `solana:${owner}?spl-token=${this.config.usdcMint}`,
      requiredCommitment: this.config.commitment,
    };
  }

  /**
   * Build an UNSIGNED USDC transfer from the user's connected wallet to their
   * Axis wallet, for them to approve in their own wallet. Arms the watch on the
   * destination so the deposit is credited once it confirms. Never signs.
   */
  async buildTransfer(
    fromWallet: string,
    owner: string,
    amountUsdc: string
  ): Promise<BuiltTransfer> {
    this.watcher.watch(owner);
    return this.builder.build(fromWallet, owner, amountUsdc);
  }

  /** Durably-credited balance for a user, as a canonical decimal USDC string. */
  balance(owner: string): { owner: string; usdc: string; baseUnits: string } {
    const base = this.ledger.balanceBaseUnits(owner);
    return { owner, usdc: fromBaseUnits(base), baseUnits: base.toString() };
  }

  /** Credited deposits for a user, decimal amounts, newest first. */
  deposits(owner: string): Array<{ signature: string; usdc: string; at: string }> {
    return this.ledger.deposits(owner).map((d) => ({
      signature: d.signature,
      usdc: fromBaseUnits(BigInt(d.baseUnits)),
      at: d.at,
    }));
  }
}

function defaultLog(r: CreditRecord): void {
  console.log(
    `[funding] credited ${fromBaseUnits(BigInt(r.baseUnits))} USDC to ${r.owner} ` +
      `(sig=${r.signature}, ${r.commitment})`
  );
}

// Re-export the money boundary so callers convert at the edge, never mid-math.
export { toBaseUnits, fromBaseUnits };
