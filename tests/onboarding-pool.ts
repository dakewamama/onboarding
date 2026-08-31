import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OnboardingPool } from "../target/types/onboarding_pool";
import {
  createMint,
  getAssociatedTokenAddress,
  getOrCreateAssociatedTokenAccount,
  getAccount,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";

describe("onboarding-pool", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.OnboardingPool as Program<OnboardingPool>;
  const authority = provider.wallet;

  const seed = new anchor.BN(1);

  let mint: PublicKey;
  let treasury: PublicKey;
  let pool: PublicKey;
  let vault: PublicKey;

  const derivePool = (s: anchor.BN) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), s.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];

  async function assertSolvent() {
    const vaultAccount = await getAccount(provider.connection, vault);
    const poolAccount = await program.account.pool.fetch(pool);
    assert.isTrue(
      new anchor.BN(vaultAccount.amount.toString()).gte(
        poolAccount.totalPrincipal
      ),
      "vault balance is below total principal"
    );
  }

  before(async () => {
    mint = await createMint(
      provider.connection,
      (authority as anchor.Wallet).payer,
      authority.publicKey,
      null,
      6
    );

    const treasuryAccount = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (authority as anchor.Wallet).payer,
      mint,
      authority.publicKey
    );
    treasury = treasuryAccount.address;

    pool = derivePool(seed);
    vault = await getAssociatedTokenAddress(mint, pool, true);
  });

  it("initializes the pool and creates the vault", async () => {
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

    const poolAccount = await program.account.pool.fetch(pool);
    assert.isTrue(poolAccount.authority.equals(authority.publicKey));
    assert.isTrue(poolAccount.treasury.equals(treasury));
    assert.isTrue(poolAccount.mint.equals(mint));
    assert.strictEqual(poolAccount.seed.toString(), seed.toString());
    assert.strictEqual(poolAccount.totalPrincipal.toString(), "0");
    assert.strictEqual(poolAccount.paused, false);

    const vaultAccount = await getAccount(provider.connection, vault);
    assert.strictEqual(vaultAccount.amount.toString(), "0");
    assert.isTrue(vaultAccount.mint.equals(mint));

    await assertSolvent();
  });

  it("rejects a treasury whose mint differs from the pool mint", async () => {
    const otherMint = await createMint(
      provider.connection,
      (authority as anchor.Wallet).payer,
      authority.publicKey,
      null,
      6
    );
    const otherTreasury = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (authority as anchor.Wallet).payer,
      otherMint,
      authority.publicKey
    );

    const otherSeed = new anchor.BN(2);
    const otherPool = derivePool(otherSeed);
    const otherVault = await getAssociatedTokenAddress(mint, otherPool, true);

    try {
      await program.methods
        .initializePool(otherSeed)
        .accountsPartial({
          authority: authority.publicKey,
          mint,
          treasury: otherTreasury.address,
          pool: otherPool,
          vault: otherVault,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      assert.fail("expected InvalidMint");
    } catch (err) {
      assert.include(err.toString(), "InvalidMint");
    }
  });
});
