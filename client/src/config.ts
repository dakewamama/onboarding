// Runtime config, read from Vite env on the client. Public values only.
// Private keys live on the operator's machine / the sponsor server, never here.
import { address, type Address } from "@solana/kit";

function req(name: string, v: string | undefined): string {
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

// import.meta.env is populated by Vite. In the sponsor server we read process.env instead.
const env = (import.meta as any).env ?? {};

export const USDC_DECIMALS = 6;

export const config = {
  privyAppId: env.VITE_PRIVY_APP_ID as string | undefined,
  rpcUrl: req("VITE_RPC_URL", env.VITE_RPC_URL),
  programId: address(req("VITE_PROGRAM_ID", env.VITE_PROGRAM_ID)) as Address,
  usdcMint: address(req("VITE_USDC_MINT", env.VITE_USDC_MINT)) as Address,
  poolSeed: BigInt(env.VITE_POOL_SEED ?? "0"),
  gasWallet: address(req("VITE_GAS_WALLET", env.VITE_GAS_WALLET)) as Address,
  collectionWallet: address(
    req("VITE_COLLECTION_WALLET", env.VITE_COLLECTION_WALLET),
  ) as Address,
  feeAmount: BigInt(env.VITE_FEE_AMOUNT ?? "10000"),
  sponsorUrl: req("VITE_SPONSOR_URL", env.VITE_SPONSOR_URL),
  devSigner: env.VITE_DEV_SIGNER === "1",
} as const;
