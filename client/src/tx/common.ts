import {
  appendTransactionMessageInstructions,
  compileTransaction,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address,
  type IInstruction,
  type Transaction,
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstruction,
  getTransferCheckedInstruction,
  TOKEN_PROGRAM_ADDRESS,
} from "@solana-program/token";
import { config, USDC_DECIMALS } from "../config";

export const rpc = createSolanaRpc(config.rpcUrl);

export async function usdcAta(owner: Address): Promise<Address> {
  const [pda] = await findAssociatedTokenPda({
    owner,
    mint: config.usdcMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  return pda;
}

// The D7 service-fee instruction: user pays a fixed USDC fee to the collection
// wallet. Composed client-side, on top of the pool instruction. The gas wallet
// (feePayer) covers SOL; the user never needs SOL. We idempotently ensure the
// collection ATA exists so the transfer can't fail on a fresh collection wallet.
export async function feeInstructions(user: Address): Promise<IInstruction[]> {
  const source = await usdcAta(user);
  const destination = await usdcAta(config.collectionWallet);
  const gas = createNoopSigner(config.gasWallet);
  return [
    getCreateAssociatedTokenIdempotentInstruction({
      payer: gas,
      owner: config.collectionWallet,
      mint: config.usdcMint,
      ata: destination,
      tokenProgram: TOKEN_PROGRAM_ADDRESS,
    }),
    getTransferCheckedInstruction({
      source,
      mint: config.usdcMint,
      destination,
      authority: createNoopSigner(user),
      amount: config.feeAmount,
      decimals: USDC_DECIMALS,
    }),
  ];
}

// Assemble a v0 transaction with the gas wallet as feePayer, then compile it.
// The returned Transaction has empty signature slots for the gas wallet and the
// user; the user fills theirs client-side, the sponsor fills the gas one.
export async function assemble(
  instructions: IInstruction[],
): Promise<Transaction> {
  const { value: blockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(config.gasWallet, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  return compileTransaction(message);
}
