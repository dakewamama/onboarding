import type { Address } from "@solana/kit";
import {
  fetchMaybePosition,
  findPoolPda,
  findPositionPda,
  type Position,
} from "../generated";
import { rpc } from "../tx/common";
import { config } from "../config";

export type PositionView = {
  address: Address;
  principal: bigint;
  // Points = integrator of principal over time (principal * seconds), u128.
  // Projected to now for display; the chain only updates it on accrue().
  projectedUnits: bigint;
  lastAccrual: bigint;
};

export async function fetchPosition(user: Address): Promise<PositionView | null> {
  const [pool] = await findPoolPda(
    { seed: config.poolSeed },
    { programAddress: config.programId },
  );
  const [positionPda] = await findPositionPda(
    { pool, user },
    { programAddress: config.programId },
  );
  const acct = await fetchMaybePosition(rpc, positionPda);
  if (!acct.exists) return null;
  const d: Position = acct.data;
  const now = BigInt(Math.floor(Date.now() / 1000));
  const elapsed = now > d.lastAccrual ? now - d.lastAccrual : 0n;
  return {
    address: positionPda,
    principal: d.principal,
    projectedUnits: d.accruedUnits + d.principal * elapsed,
    lastAccrual: d.lastAccrual,
  };
}
