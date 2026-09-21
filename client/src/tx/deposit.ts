import {
  createNoopSigner,
  type Address,
  type Transaction,
} from "@solana/kit";
import { getDepositInstructionAsync } from "../generated";
import { findPoolPda } from "../generated";
import { config } from "../config";
import { assemble, feeInstructions } from "./common";

// Builds an unsigned deposit transaction: the pool `deposit` instruction plus the
// USDC service-fee transfer, with the gas wallet as feePayer. PDAs (pool,
// position, user ATA, vault) are resolved by the generated kit client from the
// IDL — no hand-written layouts.
export async function buildDeposit(
  user: Address,
  amount: bigint,
): Promise<Transaction> {
  const [pool] = await findPoolPda(
    { seed: config.poolSeed },
    { programAddress: config.programId },
  );
  const depositIx = await getDepositInstructionAsync(
    {
      user: createNoopSigner(user),
      payer: createNoopSigner(config.gasWallet),
      mint: config.usdcMint,
      pool,
      amount,
    },
    { programAddress: config.programId },
  );
  const fee = await feeInstructions(user);
  return assemble([depositIx, ...fee]);
}
