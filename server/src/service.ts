import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import type { OnboardingPool } from "../../target/types/onboarding_pool";
import * as keystore from "./keystore";
import * as authz from "./authorizations";
import * as audit from "./audit";
import { makeProgram, derivePosition } from "./poolClient";

/**
 * The custodial signing service. Axis holds each user's key (in the keystore),
 * records the user's authorization, and signs deposit/withdraw on their behalf.
 * Every signature is gated by an authorization check and written to the audit
 * trail. The on-chain program is unchanged — it simply verifies the signature
 * Axis produces with the custodial key.
 */
export class CustodyService {
  private program: Program<OnboardingPool>;

  constructor(
    private connection: Connection,
    private operator: Keypair
  ) {
    this.program = makeProgram(connection, operator);
  }

  get programId(): PublicKey {
    return this.program.programId;
  }

  createUser(userId: string): { userId: string; publicKey: string } {
    const publicKey = keystore.createUserKey(userId);
    audit.record({ event: "user_created", userId, publicKey });
    return { userId, publicKey };
  }

  getUserPublicKey(userId: string): PublicKey {
    return new PublicKey(keystore.getUserPublicKey(userId));
  }

  authorize(
    userId: string,
    scope: authz.Action[],
    maxAmountPerTx = 0
  ): authz.Authorization {
    const auth = authz.grant(userId, scope, maxAmountPerTx);
    audit.record({
      event: "authorization_granted",
      userId,
      scope,
      maxAmountPerTx,
    });
    return auth;
  }

  async deposit(
    userId: string,
    mint: PublicKey,
    pool: PublicKey,
    amount: number
  ): Promise<string> {
    authz.assertAuthorized(userId, "deposit", amount);
    const userPk = this.getUserPublicKey(userId);
    const userAta = await getAssociatedTokenAddress(mint, userPk);
    const vault = await getAssociatedTokenAddress(mint, pool, true);
    const position = derivePosition(this.programId, pool, userPk);

    const sig = await keystore.withUserKeypair(userId, (userKp) =>
      this.program.methods
        .deposit(new anchor.BN(amount))
        .accountsPartial({
          user: userPk,
          payer: this.operator.publicKey,
          mint,
          pool,
          position,
          userAta,
          vault,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([userKp])
        .rpc()
    );

    audit.record({ event: "deposit", userId, amount, pool: pool.toBase58(), sig });
    return sig;
  }

  async withdraw(
    userId: string,
    mint: PublicKey,
    pool: PublicKey,
    amount: number
  ): Promise<string> {
    authz.assertAuthorized(userId, "withdraw", amount);
    const userPk = this.getUserPublicKey(userId);
    const userAta = await getAssociatedTokenAddress(mint, userPk);
    const vault = await getAssociatedTokenAddress(mint, pool, true);
    const position = derivePosition(this.programId, pool, userPk);

    const sig = await keystore.withUserKeypair(userId, (userKp) =>
      this.program.methods
        .withdraw(new anchor.BN(amount))
        .accountsPartial({
          user: userPk,
          mint,
          pool,
          position,
          userAta,
          vault,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .signers([userKp])
        .rpc()
    );

    audit.record({ event: "withdraw", userId, amount, pool: pool.toBase58(), sig });
    return sig;
  }

  async positionPrincipal(userId: string, pool: PublicKey): Promise<string> {
    const userPk = this.getUserPublicKey(userId);
    const position = derivePosition(this.programId, pool, userPk);
    const account = await this.program.account.position.fetchNullable(position);
    return account ? account.principal.toString() : "0";
  }
}
