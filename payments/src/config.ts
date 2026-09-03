import * as path from "path";
import { Chain, Currency, PaymentMode } from "./types";

export interface PajConfig {
  apiKey: string;
  webhookSecret: string;
  env: "production" | "staging";
  mode: PaymentMode;
  chain: Chain;
  mint: string;
  currency: Currency;
  webhookUrl?: string;
  /** Optional merchant surcharge in USDC. Sent over the wire as `businessUSDCFee`. */
  businessUsdcFee?: number;
  storeDir: string;
}

export const BASE_URLS: Record<PajConfig["env"], string> = {
  production: "https://api.paj.cash",
  staging: "https://api-staging.paj.cash",
};

// Real mainnet USDC. On staging, Paj uses a different test mint, so PAJ_MINT
// MUST be overridden there (the mainnet mint 404s on staging /token).
const MAINNET_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

export function loadConfig(env: NodeJS.ProcessEnv = process.env): PajConfig {
  const required = (k: string): string => {
    const v = env[k];
    if (!v) throw new Error(`missing required env var ${k}`);
    return v;
  };

  const envName = (env.PAJ_ENV ?? "staging").toLowerCase();
  if (envName !== "production" && envName !== "staging") {
    throw new Error(`PAJ_ENV must be "production" or "staging", got "${envName}"`);
  }

  const mode = (env.PAJ_MODE ?? "OFFRAMP").toUpperCase();
  if (mode !== "OFFRAMP" && mode !== "PAYMENT") {
    throw new Error(`PAJ_MODE must be "OFFRAMP" or "PAYMENT", got "${mode}"`);
  }

  return {
    apiKey: required("PAJ_API_KEY"),
    webhookSecret: required("PAJ_WEBHOOK_SECRET"),
    env: envName,
    mode: mode as PaymentMode,
    chain: (env.PAJ_CHAIN ?? "SOLANA") as Chain,
    mint: env.PAJ_MINT ?? MAINNET_USDC,
    currency: (env.PAJ_CURRENCY ?? "NGN") as Currency,
    webhookUrl: env.PAJ_WEBHOOK_URL,
    businessUsdcFee: env.PAJ_BUSINESS_USDC_FEE
      ? Number(env.PAJ_BUSINESS_USDC_FEE)
      : undefined,
    storeDir: env.PAJ_STORE_DIR ?? path.resolve(__dirname, "..", ".paj-store"),
  };
}
