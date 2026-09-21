import type { Address } from "@solana/kit";
import { fetchMaybePool, findPoolPda, type Pool } from "../generated";
import { rpc } from "../tx/common";
import { config } from "../config";

export type PoolView = {
  address: Address;
  authority: Address;
  treasury: Address;
  mint: Address;
  totalPrincipal: bigint;
  paused: boolean;
};

export async function fetchPool(): Promise<PoolView | null> {
  const [poolPda] = await findPoolPda(
    { seed: config.poolSeed },
    { programAddress: config.programId },
  );
  const acct = await fetchMaybePool(rpc, poolPda);
  if (!acct.exists) return null;
  const d: Pool = acct.data;
  return {
    address: poolPda,
    authority: d.authority,
    treasury: d.treasury,
    mint: d.mint,
    totalPrincipal: d.totalPrincipal,
    paused: d.paused,
  };
}
