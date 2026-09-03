/**
 * End-to-end devnet smoke script: initialize a pool, deposit, withdraw, then
 * inject a surplus and skim it to the treasury. It exercises the full happy path
 * against the deployed program.
 *
 * Run with the provider pointed at devnet:
 *
 *   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
 *   ANCHOR_WALLET=~/.config/solana/id.json \
 *   yarn run ts-node scripts/devnet-demo.ts
 *
 * The wallet needs a little devnet SOL (airdrop with `solana airdrop 2`).
 */
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OnboardingPool } from "../target/types/onboarding_pool";
import {
  createMint,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  mintTo,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.OnboardingPool as Program<OnboardingPool>;
  const authority = provider.wallet;
  const payer = (authority as anchor.Wallet).payer;

  console.log("cluster:", provider.connection.rpcEndpoint);
  console.log("program:", program.programId.toBase58());
  console.log("wallet: ", authority.publicKey.toBase58());

  // A fresh seed per run keeps repeated runs from colliding on the pool PDA.
  const seed = new anchor.BN(Date.now());
  const [pool] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), seed.toArrayLike(Buffer, "le", 8)],
    program.programId
  );

  const mint = await createMint(provider.connection, payer, authority.publicKey, null, 6);
  const treasury = (
    await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      authority.publicKey
    )
  ).address;
  const vault = await getAssociatedTokenAddress(mint, pool, true);

  console.log("\nmint:    ", mint.toBase58());
  console.log("pool:    ", pool.toBase58());
  console.log("vault:   ", vault.toBase58());
  console.log("treasury:", treasury.toBase58());

  // 1. initialize_pool
  await program.methods
    .initializePool(seed)
    .accountsPartial({
      authority: authority.publicKey,
      mint,
      treasury,
      pool,
      vault,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  console.log("\n[1] pool initialized");

  // A user with a funded token account; the wallet sponsors fees and rent.
  const user = Keypair.generate();
  const userAta = (
    await getOrCreateAssociatedTokenAccount(provider.connection, payer, mint, user.publicKey)
  ).address;
  await mintTo(provider.connection, payer, mint, userAta, authority.publicKey, BigInt(5_000_000));

  const [position] = PublicKey.findProgramAddressSync(
    [Buffer.from("position"), pool.toBuffer(), user.publicKey.toBuffer()],
    program.programId
  );

  // 2. deposit (sponsored: payer != user)
  await program.methods
    .deposit(new anchor.BN(2_000_000))
    .accountsPartial({
      user: user.publicKey,
      payer: authority.publicKey,
      mint,
      pool,
      position,
      userAta,
      vault,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .signers([user])
    .rpc();
  console.log("[2] deposited 2_000_000; total_principal =", (await program.account.pool.fetch(pool)).totalPrincipal.toString());

  // 3. withdraw
  await program.methods
    .withdraw(new anchor.BN(1_000_000))
    .accountsPartial({
      user: user.publicKey,
      mint,
      pool,
      position,
      userAta,
      vault,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .signers([user])
    .rpc();
  console.log("[3] withdrew 1_000_000; total_principal =", (await program.account.pool.fetch(pool)).totalPrincipal.toString());

  // 4. inject a surplus into the vault and skim it to the treasury
  await mintTo(provider.connection, payer, mint, vault, authority.publicKey, BigInt(250_000));
  const treasuryBefore = (await getAccount(provider.connection, treasury)).amount;
  await program.methods
    .skimExcess()
    .accountsPartial({
      authority: authority.publicKey,
      mint,
      pool,
      vault,
      treasury,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .rpc();
  const treasuryAfter = (await getAccount(provider.connection, treasury)).amount;
  console.log("[4] skimmed surplus =", (treasuryAfter - treasuryBefore).toString());

  const finalPool = await program.account.pool.fetch(pool);
  const finalVault = await getAccount(provider.connection, vault);
  console.log("\nfinal total_principal:", finalPool.totalPrincipal.toString());
  console.log("final vault balance:  ", finalVault.amount.toString());
  console.log("solvent:", BigInt(finalVault.amount.toString()) >= BigInt(finalPool.totalPrincipal.toString()));
  console.log("\ndone.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
