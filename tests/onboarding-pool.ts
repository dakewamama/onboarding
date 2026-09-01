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

  const derivePosition = (owner: PublicKey) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("position"), pool.toBuffer(), owner.toBuffer()],
      program.programId
    )[0];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  async function createFundedUser(amount: bigint) {
    const kp = Keypair.generate();
    const ata = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (authority as anchor.Wallet).payer,
      mint,
      kp.publicKey
    );
    await mintTo(
      provider.connection,
      (authority as anchor.Wallet).payer,
      mint,
      ata.address,
      authority.publicKey,
      amount
    );
    return { kp, ata: ata.address };
  }

  async function deposit(
    userKp: Keypair,
    userAta: PublicKey,
    amount: anchor.BN
  ) {
    await program.methods
      .deposit(amount)
      .accountsPartial({
        user: userKp.publicKey,
        payer: authority.publicKey,
        mint,
        pool,
        position: derivePosition(userKp.publicKey),
        userAta,
        vault,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([userKp])
      .rpc();
  }

  async function setPaused(paused: boolean) {
    await program.methods
      .setPaused(paused)
      .accountsPartial({ authority: authority.publicKey, pool })
      .rpc();
  }

  async function setTreasury(newTreasury: PublicKey) {
    await program.methods
      .setTreasury(newTreasury)
      .accountsPartial({ authority: authority.publicKey, mint, pool, newTreasury })
      .rpc();
  }

  async function sweep(treasuryAccount: PublicKey, signer?: Keypair) {
    const builder = program.methods.sweepYield().accountsPartial({
      authority: signer ? signer.publicKey : authority.publicKey,
      mint,
      pool,
      vault,
      treasury: treasuryAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
    if (signer) {
      return builder.signers([signer]).rpc();
    }
    return builder.rpc();
  }

  async function withdraw(
    userKp: Keypair,
    userAta: PublicKey,
    amount: anchor.BN
  ) {
    await program.methods
      .withdraw(amount)
      .accountsPartial({
        user: userKp.publicKey,
        payer: authority.publicKey,
        mint,
        pool,
        position: derivePosition(userKp.publicKey),
        userAta,
        vault,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([userKp])
      .rpc();
  }

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

  it("creates a position with the correct owner on first deposit", async () => {
    const user = await createFundedUser(5_000_000n);
    const amount = new anchor.BN(1_000_000);

    const before = await program.account.pool.fetch(pool);
    await deposit(user.kp, user.ata, amount);

    const position = await program.account.position.fetch(
      derivePosition(user.kp.publicKey)
    );
    assert.isTrue(position.owner.equals(user.kp.publicKey));
    assert.isTrue(position.pool.equals(pool));
    assert.strictEqual(position.principal.toString(), amount.toString());

    const after = await program.account.pool.fetch(pool);
    assert.strictEqual(
      after.totalPrincipal.sub(before.totalPrincipal).toString(),
      amount.toString()
    );

    await assertSolvent();
  });

  it("adds to principal on a second deposit without resetting owner", async () => {
    const user = await createFundedUser(5_000_000n);
    const first = new anchor.BN(1_000_000);
    const second = new anchor.BN(2_000_000);

    await deposit(user.kp, user.ata, first);
    await deposit(user.kp, user.ata, second);

    const position = await program.account.position.fetch(
      derivePosition(user.kp.publicKey)
    );
    assert.isTrue(position.owner.equals(user.kp.publicKey));
    assert.strictEqual(
      position.principal.toString(),
      first.add(second).toString()
    );

    await assertSolvent();
  });

  it("tracks two users independently and sums total principal", async () => {
    const a = await createFundedUser(5_000_000n);
    const b = await createFundedUser(5_000_000n);
    const amountA = new anchor.BN(1_500_000);
    const amountB = new anchor.BN(2_500_000);

    const before = await program.account.pool.fetch(pool);
    await deposit(a.kp, a.ata, amountA);
    await deposit(b.kp, b.ata, amountB);

    const positionA = await program.account.position.fetch(
      derivePosition(a.kp.publicKey)
    );
    const positionB = await program.account.position.fetch(
      derivePosition(b.kp.publicKey)
    );
    assert.strictEqual(positionA.principal.toString(), amountA.toString());
    assert.strictEqual(positionB.principal.toString(), amountB.toString());

    const after = await program.account.pool.fetch(pool);
    assert.strictEqual(
      after.totalPrincipal.sub(before.totalPrincipal).toString(),
      amountA.add(amountB).toString()
    );

    await assertSolvent();
  });

  it("does not let a third party overwrite an existing position owner", async () => {
    const a = await createFundedUser(5_000_000n);
    const c = await createFundedUser(5_000_000n);
    await deposit(a.kp, a.ata, new anchor.BN(1_000_000));

    try {
      await program.methods
        .deposit(new anchor.BN(1_000_000))
        .accountsPartial({
          user: c.kp.publicKey,
          payer: authority.publicKey,
          mint,
          pool,
          position: derivePosition(a.kp.publicKey),
          userAta: c.ata,
          vault,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([c.kp])
        .rpc();
      assert.fail("expected a seeds constraint violation");
    } catch (err) {
      assert.include(err.toString(), "ConstraintSeeds");
    }

    const positionA = await program.account.position.fetch(
      derivePosition(a.kp.publicKey)
    );
    assert.isTrue(positionA.owner.equals(a.kp.publicKey));
  });

  it("accrues units proportional to principal over elapsed time", async () => {
    const user = await createFundedUser(5_000_000n);
    const principal = new anchor.BN(1_000_000);

    await deposit(user.kp, user.ata, principal);
    const start = await program.account.position.fetch(
      derivePosition(user.kp.publicKey)
    );

    await sleep(2000);
    await deposit(user.kp, user.ata, new anchor.BN(1));

    const end = await program.account.position.fetch(
      derivePosition(user.kp.publicKey)
    );

    const elapsed = end.lastAccrual.sub(start.lastAccrual);
    const expected = principal.mul(elapsed);
    const diff = end.accruedUnits.sub(expected).abs();
    assert.isTrue(
      diff.lte(principal),
      `accrued ${end.accruedUnits} expected ~${expected}`
    );

    await assertSolvent();
  });

  it("reduces principal and zeroes accrued units on a partial withdraw", async () => {
    const user = await createFundedUser(5_000_000n);
    await deposit(user.kp, user.ata, new anchor.BN(3_000_000));

    await sleep(1500);
    await withdraw(user.kp, user.ata, new anchor.BN(1_000_000));

    const position = await program.account.position.fetch(
      derivePosition(user.kp.publicKey)
    );
    assert.strictEqual(position.principal.toString(), "2000000");
    assert.strictEqual(position.accruedUnits.toString(), "0");

    await assertSolvent();
  });

  it("withdraws the full amount and leaves the position open", async () => {
    const user = await createFundedUser(5_000_000n);
    await deposit(user.kp, user.ata, new anchor.BN(2_000_000));

    await withdraw(user.kp, user.ata, new anchor.BN(2_000_000));

    const position = await program.account.position.fetch(
      derivePosition(user.kp.publicKey)
    );
    assert.strictEqual(position.principal.toString(), "0");
    assert.isTrue(position.owner.equals(user.kp.publicKey));

    await assertSolvent();
  });

  it("rejects a withdraw exceeding principal", async () => {
    const user = await createFundedUser(5_000_000n);
    await deposit(user.kp, user.ata, new anchor.BN(1_000_000));

    try {
      await withdraw(user.kp, user.ata, new anchor.BN(1_500_000));
      assert.fail("expected InsufficientPrincipal");
    } catch (err) {
      assert.include(err.toString(), "InsufficientPrincipal");
    }

    await assertSolvent();
  });

  it("rejects a sweep when there is no excess", async () => {
    try {
      await sweep(treasury);
      assert.fail("expected NothingToSweep");
    } catch (err) {
      assert.include(err.toString(), "NothingToSweep");
    }

    await assertSolvent();
  });

  it("sweeps excess above the margin and leaves principal untouched", async () => {
    const injected = 10_000n;
    await mintTo(
      provider.connection,
      (authority as anchor.Wallet).payer,
      mint,
      vault,
      authority.publicKey,
      injected
    );

    const poolBefore = await program.account.pool.fetch(pool);
    const treasuryBefore = await getAccount(provider.connection, treasury);

    await sweep(treasury);

    const poolAfter = await program.account.pool.fetch(pool);
    const treasuryAfter = await getAccount(provider.connection, treasury);

    const expectedSwept = injected - 1_000n;
    assert.strictEqual(
      (treasuryAfter.amount - treasuryBefore.amount).toString(),
      expectedSwept.toString()
    );
    assert.strictEqual(
      poolAfter.totalPrincipal.toString(),
      poolBefore.totalPrincipal.toString()
    );

    await assertSolvent();
  });

  it("rejects a sweep from a non authority", async () => {
    const intruder = Keypair.generate();
    try {
      await sweep(treasury, intruder);
      assert.fail("expected a has_one violation");
    } catch (err) {
      assert.include(err.toString(), "ConstraintHasOne");
    }

    await assertSolvent();
  });

  it("rejects a sweep to a treasury other than the pool treasury", async () => {
    const wrong = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (authority as anchor.Wallet).payer,
      mint,
      Keypair.generate().publicKey
    );

    try {
      await sweep(wrong.address);
      assert.fail("expected InvalidTreasury");
    } catch (err) {
      assert.include(err.toString(), "InvalidTreasury");
    }

    await assertSolvent();
  });

  it("blocks deposit and withdraw while paused", async () => {
    const user = await createFundedUser(5_000_000n);
    await deposit(user.kp, user.ata, new anchor.BN(2_000_000));

    await setPaused(true);

    try {
      await deposit(user.kp, user.ata, new anchor.BN(1_000_000));
      assert.fail("expected Paused on deposit");
    } catch (err) {
      assert.include(err.toString(), "Paused");
    }

    try {
      await withdraw(user.kp, user.ata, new anchor.BN(1_000_000));
      assert.fail("expected Paused on withdraw");
    } catch (err) {
      assert.include(err.toString(), "Paused");
    }

    await setPaused(false);
    await withdraw(user.kp, user.ata, new anchor.BN(2_000_000));

    await assertSolvent();
  });

  it("updates the treasury to another account of the same mint", async () => {
    const fresh = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (authority as anchor.Wallet).payer,
      mint,
      Keypair.generate().publicKey
    );

    await setTreasury(fresh.address);
    let poolAccount = await program.account.pool.fetch(pool);
    assert.isTrue(poolAccount.treasury.equals(fresh.address));

    await setTreasury(treasury);
    poolAccount = await program.account.pool.fetch(pool);
    assert.isTrue(poolAccount.treasury.equals(treasury));
  });

  it("rejects a treasury update whose mint differs from the pool mint", async () => {
    const otherMint = await createMint(
      provider.connection,
      (authority as anchor.Wallet).payer,
      authority.publicKey,
      null,
      6
    );
    const otherAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      (authority as anchor.Wallet).payer,
      otherMint,
      authority.publicKey
    );

    try {
      await setTreasury(otherAta.address);
      assert.fail("expected a token mint constraint violation");
    } catch (err) {
      assert.include(err.toString(), "ConstraintTokenMint");
    }
  });
});
