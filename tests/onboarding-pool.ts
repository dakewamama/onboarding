import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { OnboardingPool } from "../target/types/onboarding_pool";
import {
  createMint,
  createAccount,
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
  const payer = (authority as anchor.Wallet).payer;

  // One shared asset; every test gets its own pool, so nothing bleeds across
  // tests. Seeds are handed out from a monotonic counter.
  let mint: PublicKey;
  let seedCounter = 1;

  // Per-test state, reset in beforeEach.
  let seed: anchor.BN;
  let pool: PublicKey;
  let vault: PublicKey;
  let treasury: PublicKey;

  const derivePool = (s: anchor.BN) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("pool"), s.toArrayLike(Buffer, "le", 8)],
      program.programId
    )[0];

  const derivePosition = (owner: PublicKey, poolKey: PublicKey = pool) =>
    PublicKey.findProgramAddressSync(
      [Buffer.from("position"), poolKey.toBuffer(), owner.toBuffer()],
      program.programId
    )[0];

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  const nextSeed = () => new anchor.BN(seedCounter++);

  // Asserts that `promise` rejects with a specific Anchor error code (program
  // error name or built-in constraint name), not a brittle substring.
  async function expectError(promise: Promise<unknown>, code: string) {
    try {
      await promise;
      assert.fail(`expected error ${code}`);
    } catch (err) {
      if (err instanceof anchor.AnchorError) {
        assert.strictEqual(
          err.error.errorCode.code,
          code,
          `expected ${code}, got ${err.error.errorCode.code}`
        );
      } else {
        throw err;
      }
    }
  }

  // Asserts that `promise` rejects at all — used where the failure comes from the
  // SPL token program (not an Anchor error with a stable code).
  async function expectReject(promise: Promise<unknown>) {
    try {
      await promise;
      assert.fail("expected the call to reject");
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("expected the call")) {
        throw err;
      }
    }
  }

  async function freshTokenAccount(owner: PublicKey) {
    const account = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      mint,
      owner
    );
    return account.address;
  }

  async function createFundedUser(amount: bigint) {
    const kp = Keypair.generate();
    const ata = await freshTokenAccount(kp.publicKey);
    await mintTo(provider.connection, payer, mint, ata, authority.publicKey, amount);
    return { kp, ata };
  }

  async function initializePool(
    s: anchor.BN,
    poolKey: PublicKey,
    vaultKey: PublicKey,
    treasuryKey: PublicKey
  ) {
    await program.methods
      .initializePool(s)
      .accountsPartial({
        authority: authority.publicKey,
        mint,
        treasury: treasuryKey,
        pool: poolKey,
        vault: vaultKey,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();
  }

  function deposit(userKp: Keypair, userAta: PublicKey, amount: anchor.BN) {
    return program.methods
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

  function withdraw(userKp: Keypair, userAta: PublicKey, amount: anchor.BN) {
    return program.methods
      .withdraw(amount)
      .accountsPartial({
        user: userKp.publicKey,
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

  function closePosition(userKp: Keypair) {
    return program.methods
      .closePosition()
      .accountsPartial({
        owner: userKp.publicKey,
        rentReceiver: authority.publicKey,
        position: derivePosition(userKp.publicKey),
      })
      .signers([userKp])
      .rpc();
  }

  function setPaused(paused: boolean) {
    return program.methods
      .setPaused(paused)
      .accountsPartial({ authority: authority.publicKey, pool })
      .rpc();
  }

  function setTreasury(newTreasury: PublicKey) {
    return program.methods
      .setTreasury(newTreasury)
      .accountsPartial({ authority: authority.publicKey, mint, pool, newTreasury })
      .rpc();
  }

  function skim(treasuryAccount: PublicKey, signer?: Keypair) {
    const builder = program.methods.skimExcess().accountsPartial({
      authority: signer ? signer.publicKey : authority.publicKey,
      mint,
      pool,
      vault,
      treasury: treasuryAccount,
      tokenProgram: TOKEN_PROGRAM_ID,
    });
    return signer ? builder.signers([signer]).rpc() : builder.rpc();
  }

  // Checks the two invariants observable from a single account read:
  //   1. Solvency:  vault.amount >= pool.total_principal
  //   2. Principal conservation:  total_principal == sum of position principals
  async function assertInvariants() {
    const vaultAccount = await getAccount(provider.connection, vault);
    const poolAccount = await program.account.pool.fetch(pool);

    assert.isTrue(
      new anchor.BN(vaultAccount.amount.toString()).gte(poolAccount.totalPrincipal),
      "invariant 1 (solvency) violated"
    );

    // Position layout: discriminator(8) + owner(32) => pool field at offset 40.
    const positions = await program.account.position.all([
      { memcmp: { offset: 8 + 32, bytes: pool.toBase58() } },
    ]);
    const sum = positions.reduce(
      (acc, p) => acc.add(p.account.principal),
      new anchor.BN(0)
    );
    assert.strictEqual(
      sum.toString(),
      poolAccount.totalPrincipal.toString(),
      "invariant 2 (principal conservation) violated"
    );
  }

  before(async () => {
    mint = await createMint(provider.connection, payer, authority.publicKey, null, 6);
  });

  beforeEach(async () => {
    seed = nextSeed();
    pool = derivePool(seed);
    vault = await getAssociatedTokenAddress(mint, pool, true);
    treasury = await freshTokenAccount(Keypair.generate().publicKey);
    await initializePool(seed, pool, vault, treasury);
  });

  it("initializes the pool and creates the vault", async () => {
    const poolAccount = await program.account.pool.fetch(pool);
    assert.isTrue(poolAccount.authority.equals(authority.publicKey));
    assert.isTrue(poolAccount.pendingAuthority.equals(PublicKey.default));
    assert.isTrue(poolAccount.treasury.equals(treasury));
    assert.isTrue(poolAccount.mint.equals(mint));
    assert.strictEqual(poolAccount.seed.toString(), seed.toString());
    assert.strictEqual(poolAccount.totalPrincipal.toString(), "0");
    assert.strictEqual(poolAccount.paused, false);

    const vaultAccount = await getAccount(provider.connection, vault);
    assert.strictEqual(vaultAccount.amount.toString(), "0");
    assert.isTrue(vaultAccount.mint.equals(mint));

    await assertInvariants();
  });

  it("rejects a treasury whose mint differs from the pool mint", async () => {
    const otherMint = await createMint(
      provider.connection,
      payer,
      authority.publicKey,
      null,
      6
    );
    const otherTreasury = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      otherMint,
      authority.publicKey
    );

    const badSeed = nextSeed();
    const badPool = derivePool(badSeed);
    const badVault = await getAssociatedTokenAddress(mint, badPool, true);

    await expectError(
      initializePool(badSeed, badPool, badVault, otherTreasury.address),
      "InvalidMint"
    );
  });

  it("creates a position with the correct owner on first deposit", async () => {
    const user = await createFundedUser(5_000_000n);
    const amount = new anchor.BN(1_000_000);

    await deposit(user.kp, user.ata, amount);

    const position = await program.account.position.fetch(
      derivePosition(user.kp.publicKey)
    );
    assert.isTrue(position.owner.equals(user.kp.publicKey));
    assert.isTrue(position.pool.equals(pool));
    assert.strictEqual(position.principal.toString(), amount.toString());

    const poolAccount = await program.account.pool.fetch(pool);
    assert.strictEqual(poolAccount.totalPrincipal.toString(), amount.toString());

    await assertInvariants();
  });

  it("rejects a zero-amount deposit", async () => {
    const user = await createFundedUser(5_000_000n);
    await expectError(
      deposit(user.kp, user.ata, new anchor.BN(0)),
      "InvalidAmount"
    );
    await assertInvariants();
  });

  it("rejects a deposit larger than the user balance", async () => {
    const user = await createFundedUser(1_000_000n);
    // Program checks pass; the SPL token transfer fails on insufficient funds.
    await expectReject(deposit(user.kp, user.ata, new anchor.BN(2_000_000)));
    await assertInvariants();
  });

  it("rejects a deposit into a spoofed vault", async () => {
    const user = await createFundedUser(5_000_000n);
    // A real token account of the mint, but not the pool's associated vault.
    const fakeVault = await freshTokenAccount(Keypair.generate().publicKey);

    await expectReject(
      program.methods
        .deposit(new anchor.BN(1_000_000))
        .accountsPartial({
          user: user.kp.publicKey,
          payer: authority.publicKey,
          mint,
          pool,
          position: derivePosition(user.kp.publicKey),
          userAta: user.ata,
          vault: fakeVault,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([user.kp])
        .rpc()
    );
    await assertInvariants();
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
    assert.strictEqual(position.principal.toString(), first.add(second).toString());

    await assertInvariants();
  });

  it("tracks two users independently and sums total principal", async () => {
    const a = await createFundedUser(5_000_000n);
    const b = await createFundedUser(5_000_000n);
    const amountA = new anchor.BN(1_500_000);
    const amountB = new anchor.BN(2_500_000);

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

    const poolAccount = await program.account.pool.fetch(pool);
    assert.strictEqual(
      poolAccount.totalPrincipal.toString(),
      amountA.add(amountB).toString()
    );

    await assertInvariants();
  });

  it("does not let a third party overwrite an existing position owner", async () => {
    const a = await createFundedUser(5_000_000n);
    const c = await createFundedUser(5_000_000n);
    await deposit(a.kp, a.ata, new anchor.BN(1_000_000));

    await expectError(
      program.methods
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
        .rpc(),
      "ConstraintSeeds"
    );

    const positionA = await program.account.position.fetch(
      derivePosition(a.kp.publicKey)
    );
    assert.isTrue(positionA.owner.equals(a.kp.publicKey));
  });

  it("accrues points equal to principal times elapsed seconds", async () => {
    const user = await createFundedUser(5_000_000n);
    const principal = new anchor.BN(1_000_000);

    await deposit(user.kp, user.ata, principal);
    const start = await program.account.position.fetch(
      derivePosition(user.kp.publicKey)
    );

    await sleep(1500);
    // A second deposit accrues on the pre-existing principal before adding.
    await deposit(user.kp, user.ata, new anchor.BN(1));

    const end = await program.account.position.fetch(
      derivePosition(user.kp.publicKey)
    );

    // Exact identity, not a tolerance: points == principal × elapsed.
    const elapsed = end.lastAccrual.sub(start.lastAccrual);
    const expected = start.principal.mul(elapsed);
    assert.strictEqual(end.points.toString(), expected.toString());
    assert.isTrue(elapsed.gtn(0), "elapsed should be non-zero");

    await assertInvariants();
  });

  it("rejects a zero-amount withdraw", async () => {
    const user = await createFundedUser(5_000_000n);
    await deposit(user.kp, user.ata, new anchor.BN(1_000_000));
    await expectError(
      withdraw(user.kp, user.ata, new anchor.BN(0)),
      "InvalidAmount"
    );
    await assertInvariants();
  });

  it("reduces principal but preserves points on a partial withdraw", async () => {
    const user = await createFundedUser(5_000_000n);
    await deposit(user.kp, user.ata, new anchor.BN(3_000_000));

    await sleep(1200);
    await withdraw(user.kp, user.ata, new anchor.BN(1_000_000));

    const position = await program.account.position.fetch(
      derivePosition(user.kp.publicKey)
    );
    assert.strictEqual(position.principal.toString(), "2000000");
    // Points are monotonic (invariant 4): a withdraw never resets them.
    assert.isTrue(position.points.gt(new anchor.BN(0)));

    await assertInvariants();
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

    await assertInvariants();
  });

  it("rejects a withdraw exceeding principal", async () => {
    const user = await createFundedUser(5_000_000n);
    await deposit(user.kp, user.ata, new anchor.BN(1_000_000));

    await expectError(
      withdraw(user.kp, user.ata, new anchor.BN(1_500_000)),
      "InsufficientPrincipal"
    );

    await assertInvariants();
  });

  it("rejects closing a position that still holds principal", async () => {
    const user = await createFundedUser(5_000_000n);
    await deposit(user.kp, user.ata, new anchor.BN(1_000_000));

    await expectError(closePosition(user.kp), "PositionNotEmpty");

    await withdraw(user.kp, user.ata, new anchor.BN(1_000_000));
    await assertInvariants();
  });

  it("closes an empty position and lets the owner redeposit fresh", async () => {
    const user = await createFundedUser(5_000_000n);
    await deposit(user.kp, user.ata, new anchor.BN(2_000_000));
    await withdraw(user.kp, user.ata, new anchor.BN(2_000_000));

    await closePosition(user.kp);
    const closed = await program.account.position.fetchNullable(
      derivePosition(user.kp.publicKey)
    );
    assert.isNull(closed);

    // Redeposit reinitializes the position from scratch with the correct owner.
    await deposit(user.kp, user.ata, new anchor.BN(1_000_000));
    const reopened = await program.account.position.fetch(
      derivePosition(user.kp.publicKey)
    );
    assert.strictEqual(reopened.principal.toString(), "1000000");
    assert.isTrue(reopened.owner.equals(user.kp.publicKey));
    assert.strictEqual(reopened.points.toString(), "0");

    await withdraw(user.kp, user.ata, new anchor.BN(1_000_000));
    await assertInvariants();
  });

  it("deposits and withdraws through a non-ATA user token account", async () => {
    const userKp = Keypair.generate();
    // A plain token account owned by the user, not the associated token account.
    const nonAta = await createAccount(
      provider.connection,
      payer,
      mint,
      userKp.publicKey,
      Keypair.generate()
    );
    await mintTo(provider.connection, payer, mint, nonAta, authority.publicKey, 2_000_000n);

    await deposit(userKp, nonAta, new anchor.BN(1_500_000));
    const position = await program.account.position.fetch(
      derivePosition(userKp.publicKey)
    );
    assert.strictEqual(position.principal.toString(), "1500000");

    await withdraw(userKp, nonAta, new anchor.BN(1_500_000));
    const account = await getAccount(provider.connection, nonAta);
    assert.strictEqual(account.amount.toString(), "2000000");

    await assertInvariants();
  });

  it("rejects a skim when there is no excess", async () => {
    await expectError(skim(treasury), "NothingToSkim");
    await assertInvariants();
  });

  it("skims the full excess and leaves principal untouched", async () => {
    const user = await createFundedUser(5_000_000n);
    await deposit(user.kp, user.ata, new anchor.BN(1_000_000));

    const injected = 10_000n;
    await mintTo(provider.connection, payer, mint, vault, authority.publicKey, injected);

    const poolBefore = await program.account.pool.fetch(pool);
    const treasuryBefore = await getAccount(provider.connection, treasury);

    await skim(treasury);

    const poolAfter = await program.account.pool.fetch(pool);
    const treasuryAfter = await getAccount(provider.connection, treasury);

    // The whole surplus is skimmed; there is no retained margin.
    assert.strictEqual(
      (treasuryAfter.amount - treasuryBefore.amount).toString(),
      injected.toString()
    );
    assert.strictEqual(
      poolAfter.totalPrincipal.toString(),
      poolBefore.totalPrincipal.toString()
    );

    await assertInvariants();
  });

  it("rejects a skim from a non authority", async () => {
    await expectError(skim(treasury, Keypair.generate()), "ConstraintHasOne");
    await assertInvariants();
  });

  it("rejects a skim to a treasury other than the pool treasury", async () => {
    const wrong = await freshTokenAccount(Keypair.generate().publicKey);
    // Give it a surplus so the treasury check is what actually fails.
    await mintTo(provider.connection, payer, mint, vault, authority.publicKey, 5_000n);
    await expectError(skim(wrong), "InvalidTreasury");
    // Clean the injected surplus back out so invariants hold for the next test.
    await skim(treasury);
    await assertInvariants();
  });

  it("blocks deposit and skim while paused but never withdraw", async () => {
    const user = await createFundedUser(5_000_000n);
    await deposit(user.kp, user.ata, new anchor.BN(2_000_000));

    await setPaused(true);

    await expectError(deposit(user.kp, user.ata, new anchor.BN(1_000_000)), "Paused");
    await expectError(skim(treasury), "Paused");

    // Invariant 3: withdrawal liveness holds even while paused.
    await withdraw(user.kp, user.ata, new anchor.BN(2_000_000));
    const position = await program.account.position.fetch(
      derivePosition(user.kp.publicKey)
    );
    assert.strictEqual(position.principal.toString(), "0");

    await assertInvariants();
  });

  it("updates the treasury to another account of the same mint", async () => {
    const fresh = await freshTokenAccount(Keypair.generate().publicKey);

    await setTreasury(fresh);
    let poolAccount = await program.account.pool.fetch(pool);
    assert.isTrue(poolAccount.treasury.equals(fresh));

    await setTreasury(treasury);
    poolAccount = await program.account.pool.fetch(pool);
    assert.isTrue(poolAccount.treasury.equals(treasury));
  });

  it("rejects a treasury update whose mint differs from the pool mint", async () => {
    const otherMint = await createMint(
      provider.connection,
      payer,
      authority.publicKey,
      null,
      6
    );
    const otherAta = await getOrCreateAssociatedTokenAccount(
      provider.connection,
      payer,
      otherMint,
      authority.publicKey
    );

    await expectError(setTreasury(otherAta.address), "ConstraintTokenMint");
  });

  it("rotates authority via two-step propose and accept", async () => {
    const next = Keypair.generate();
    const intruder = Keypair.generate();

    // A non-authority cannot propose.
    await expectError(
      program.methods
        .proposeAuthority(next.publicKey)
        .accountsPartial({ authority: intruder.publicKey, pool })
        .signers([intruder])
        .rpc(),
      "ConstraintHasOne"
    );

    // Accept with no pending proposal is rejected.
    await expectError(
      program.methods
        .acceptAuthority()
        .accountsPartial({ newAuthority: next.publicKey, pool })
        .signers([next])
        .rpc(),
      "NoPendingAuthority"
    );

    // Current authority proposes the next one.
    await program.methods
      .proposeAuthority(next.publicKey)
      .accountsPartial({ authority: authority.publicKey, pool })
      .rpc();

    // Accept by the wrong key is rejected.
    const wrong = Keypair.generate();
    await expectError(
      program.methods
        .acceptAuthority()
        .accountsPartial({ newAuthority: wrong.publicKey, pool })
        .signers([wrong])
        .rpc(),
      "NotPendingAuthority"
    );

    // The pending authority accepts.
    await program.methods
      .acceptAuthority()
      .accountsPartial({ newAuthority: next.publicKey, pool })
      .signers([next])
      .rpc();

    let p = await program.account.pool.fetch(pool);
    assert.isTrue(p.authority.equals(next.publicKey));
    assert.isTrue(p.pendingAuthority.equals(PublicKey.default));

    // Authority-gated instructions follow the new authority and reject the old.
    await expectError(
      program.methods
        .setPaused(true)
        .accountsPartial({ authority: authority.publicKey, pool })
        .rpc(),
      "ConstraintHasOne"
    );

    await program.methods
      .setPaused(true)
      .accountsPartial({ authority: next.publicKey, pool })
      .signers([next])
      .rpc();
    p = await program.account.pool.fetch(pool);
    assert.strictEqual(p.paused, true);
  });
});
