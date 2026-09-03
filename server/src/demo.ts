/**
 * End-to-end custodial flow on devnet. Proves that Axis, holding the user's key,
 * can deposit and withdraw on the user's behalf — but only after the user has
 * authorized it, and with every signature audited.
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn run custody-demo
 *
 * The operator wallet needs some devnet SOL (`solana airdrop 2`). All keys here
 * are throwaway devnet keys.
 */
import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import {
  createMint,
  getOrCreateAssociatedTokenAccount,
  getAssociatedTokenAddress,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { connection, loadOperatorKeypair } from "./config";
import { makeProgram, derivePool } from "./poolClient";
import { CustodyService } from "./service";
import * as audit from "./audit";

async function main() {
  const conn = connection();
  const operator = loadOperatorKeypair();
  const program = makeProgram(conn, operator);

  console.log("cluster: ", conn.rpcEndpoint);
  console.log("program: ", program.programId.toBase58());
  console.log("operator:", operator.publicKey.toBase58());

  // A test mint (operator is mint authority so it can fund the custodial user);
  // in production this is real USDC and funds come from the user.
  const mint = await createMint(conn, operator, operator.publicKey, null, 6);
  const treasury = (
    await getOrCreateAssociatedTokenAccount(conn, operator, mint, operator.publicKey)
  ).address;

  const seed = new anchor.BN(Date.now());
  const pool = derivePool(program.programId, seed);
  const vault = await getAssociatedTokenAddress(mint, pool, true);

  await program.methods
    .initializePool(seed)
    .accountsPartial({
      authority: operator.publicKey,
      mint,
      treasury,
      pool,
      vault,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("\npool initialized:", pool.toBase58());

  const svc = new CustodyService(conn, operator);
  const userId = `user_${Date.now()}`;

  // 1. Axis creates and holds a custodial key for the user.
  const { publicKey } = svc.createUser(userId);
  console.log(`\n[1] custodial user ${userId} -> ${publicKey}`);

  // Provision + fund the user's token account (stands in for the user's funds
  // arriving). Operator mints test tokens to the custodial user's ATA.
  const userPk = new PublicKey(publicKey);
  const userAta = (
    await getOrCreateAssociatedTokenAccount(conn, operator, mint, userPk)
  ).address;
  await mintTo(conn, operator, mint, userAta, operator.publicKey, BigInt(5_000_000));
  console.log("    funded custodial user with 5_000_000 test tokens");

  // 2. Signing without authorization must fail.
  try {
    await svc.deposit(userId, mint, pool, 2_000_000);
    throw new Error("BUG: deposit succeeded without authorization");
  } catch (err) {
    console.log("[2] deposit blocked before consent:", (err as Error).message);
  }

  // 3. User grants Axis permission to pay and transfer on their behalf.
  svc.authorize(userId, ["deposit", "withdraw"], 3_000_000);
  console.log("[3] user authorized deposit+withdraw (max 3_000_000/tx)");

  // 4. Axis signs a deposit on the user's behalf.
  const depSig = await svc.deposit(userId, mint, pool, 2_000_000);
  console.log("[4] deposited 2_000_000; principal =", await svc.positionPrincipal(userId, pool));
  console.log("    sig:", depSig);

  // 5. Over-limit deposit is rejected by the authorization scope.
  try {
    await svc.deposit(userId, mint, pool, 9_000_000);
    throw new Error("BUG: over-limit deposit succeeded");
  } catch (err) {
    console.log("[5] over-limit deposit blocked:", (err as Error).message);
  }

  // 6. Axis signs a withdraw on the user's behalf.
  const wdSig = await svc.withdraw(userId, mint, pool, 1_000_000);
  console.log("[6] withdrew 1_000_000; principal =", await svc.positionPrincipal(userId, pool));
  console.log("    sig:", wdSig);

  const finalVault = await getAccount(conn, vault);
  const finalPool = await program.account.pool.fetch(pool);
  console.log("\nvault balance:  ", finalVault.amount.toString());
  console.log("total_principal:", finalPool.totalPrincipal.toString());
  console.log(
    "solvent:",
    BigInt(finalVault.amount.toString()) >= BigInt(finalPool.totalPrincipal.toString())
  );

  console.log("\naudit trail (last 5):");
  for (const line of audit.tail(5)) console.log("  " + line);

  console.log("\ndone.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
