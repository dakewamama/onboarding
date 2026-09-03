import * as fs from "fs";
import * as path from "path";
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import type { OnboardingPool } from "../../target/types/onboarding_pool";

// Load the IDL at runtime (avoids needing resolveJsonModule). The program ID is
// read from the IDL `address` field written by `anchor build`.
const idl = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, "../../target/idl/onboarding_pool.json"),
    "utf8"
  )
) as OnboardingPool;

export function makeProgram(
  connection: Connection,
  operator: Keypair
): Program<OnboardingPool> {
  const wallet = new anchor.Wallet(operator);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
  });
  return new anchor.Program(idl, provider);
}

export function derivePool(programId: PublicKey, seed: anchor.BN): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool"), seed.toArrayLike(Buffer, "le", 8)],
    programId
  )[0];
}

export function derivePosition(
  programId: PublicKey,
  pool: PublicKey,
  owner: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), pool.toBuffer(), owner.toBuffer()],
    programId
  )[0];
}
