import * as path from "path";

/**
 * Crypto-funding (USDC on Solana) configuration. Sits ALONGSIDE the Paj module —
 * this is a separate, additive funding path, not a replacement. Every value comes
 * from env; nothing is committed. Mirrors payments/src/config.ts in spirit.
 */
export interface FundingConfig {
  /** JSON-RPC endpoint. Required — no default RPC, so a misconfig fails loudly. */
  rpcUrl: string;
  /** USDC SPL mint address. Defaults to mainnet USDC; override on devnet/staging. */
  usdcMint: string;
  /** Commitment a deposit must reach before we credit it. */
  commitment: "confirmed" | "finalized";
  /** How often the watcher polls the chain, milliseconds. */
  pollIntervalMs: number;
  /** How many signatures to pull per address per poll. */
  pageSize: number;
  /** Durable store directory (gitignored). Deposits survive restarts here. */
  storeDir: string;
  /**
   * Browser origins allowed to call /funding/* cross-origin (the Vercel frontend
   * calling the Railway backend). ["*"] allows any; [] disables CORS (same-origin
   * / server-to-server only). From env, never committed.
   */
  corsOrigins: string[];
}

// Real mainnet USDC (6 decimals). Same constant the Paj module pins.
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function loadFundingConfig(
  env: NodeJS.ProcessEnv = process.env
): FundingConfig {
  const rpcUrl = env.SOLANA_RPC_URL;
  if (!rpcUrl) {
    throw new Error(
      "SOLANA_RPC_URL is required for the crypto-funding flow (deposit watch + tx build)"
    );
  }

  const commitment = (env.SOLANA_COMMITMENT ?? "finalized").toLowerCase();
  if (commitment !== "confirmed" && commitment !== "finalized") {
    throw new Error(
      `SOLANA_COMMITMENT must be "confirmed" or "finalized", got "${commitment}"`
    );
  }

  return {
    rpcUrl,
    usdcMint: env.SOLANA_USDC_MINT ?? MAINNET_USDC,
    commitment,
    pollIntervalMs: env.FUNDING_POLL_INTERVAL_MS
      ? Number(env.FUNDING_POLL_INTERVAL_MS)
      : 15000,
    pageSize: env.FUNDING_PAGE_SIZE ? Number(env.FUNDING_PAGE_SIZE) : 25,
    storeDir:
      env.FUNDING_STORE_DIR ??
      path.resolve(__dirname, "..", "..", ".funding-store"),
    corsOrigins: (env.FUNDING_CORS_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
