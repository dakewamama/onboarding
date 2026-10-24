import {
  createNoopSigner,
  type Address,
  type Transaction,
} from "@solana/kit";
import { getWithdrawInstructionAsync, findPoolPda } from "../generated";
import { config } from "../config";
import { assemble, feeInstructions } from "./common";

// Builds an unsigned withdraw transaction: the pool `withdraw` instruction plus
// the USDC service-fee transfer, gas wallet as feePayer. Note (D5): withdrawing
// forfeits accrued points on-chain — surfaced in the UI, not enforced here.
export async function buildWithdraw(
  user: Address,
  amount: bigint,
): Promise<Transaction> {
  const [pool] = await findPoolPda(
    { seed: config.poolSeed },
    { programAddress: config.programId },
  );
  const withdrawIx = await getWithdrawInstructionAsync(
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
  return assemble([withdrawIx, ...fee]);
}
