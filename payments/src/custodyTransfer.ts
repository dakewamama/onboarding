import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { walletAddressFor, withUserKeypair } from "./custody";
import { fundingStoreDir, loadFundingConfig } from "./funding/config";
import { DepositLedger } from "./funding/depositLedger";
import {
  InsufficientBalanceError,
  SpendLedger,
  type SpendState,
} from "./funding/spendLedger";

export type CustodyTransferStatus =
  | "pending"
  | "settled"
  | "failed"
  | "in_doubt";

export interface CustodyTransferInput {
  owner: string;
  asset: "USDC";
  network: "SOLANA";
  destination: string;
  amountMinor: string;
  maxDebitMinor: string;
  idempotencyKey: string;
}

export interface CustodyTransferResponse {
  status: CustodyTransferStatus;
  requestId: string;
  amountMinor: string;
  signature?: string;
}

interface StoredTransfer extends CustodyTransferInput {
  requestId: string;
  intentDigest: string;
  ledgerOwner: string;
  status: CustodyTransferStatus;
  createdAt: string;
  updatedAt: string;
  signature?: string;
  blockhash?: string;
  lastValidBlockHeight?: number;
  broadcastAcceptedAt?: string;
  error?: string;
}

interface Chain {
  getLatestBlockhash(
    commitment?: "confirmed" | "finalized",
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }>;

  sendRawTransaction(
    raw: Buffer | Uint8Array,
    options?: { skipPreflight?: boolean; maxRetries?: number },
  ): Promise<string>;

  getSignatureStatuses(
    signatures: string[],
    config?: { searchTransactionHistory?: boolean },
  ): Promise<{
    value: Array<{
      err: unknown;
      confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
    } | null>;
  }>;
}

export interface CustodyTransferDeps {
  connection: Chain;
  storeDir: string;
  mint: PublicKey;
  commitment: "confirmed" | "finalized";
  operator: Keypair;
  walletAddressFor?: (storeDir: string, userId: string) => string | null;
  withUserKeypair?: <T>(
    storeDir: string,
    userId: string,
    fn: (kp: Keypair) => Promise<T>,
    env?: NodeJS.ProcessEnv,
  ) => Promise<T>;
  env?: NodeJS.ProcessEnv;
}

export class CustodyTransferConflict extends Error {}
export class CustodyTransferNotFound extends Error {}

function positive(value: string, field: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${field} must be a positive integer string`);
  }
  return BigInt(value);
}

function transferDir(storeDir: string): string {
  return path.join(storeDir, "custody-transfers");
}

function transferPath(storeDir: string, key: string): string {
  const name = createHash("sha256").update(key).digest("hex");
  return path.join(transferDir(storeDir), `${name}.json`);
}

function stableRequestId(key: string): string {
  return createHash("sha256")
    .update(`axis-custody-transfer:${key}`)
    .digest("hex");
}

function intentDigest(input: CustodyTransferInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.owner,
        input.asset,
        input.network,
        input.destination,
        input.amountMinor,
        input.maxDebitMinor,
        input.idempotencyKey,
      ]),
    )
    .digest("hex");
}

function readTransfer(storeDir: string, key: string): StoredTransfer {
  const file = transferPath(storeDir, key);
  if (!fs.existsSync(file)) {
    throw new CustodyTransferNotFound("custody transfer not found");
  }
  return JSON.parse(fs.readFileSync(file, "utf8")) as StoredTransfer;
}

function writeTransfer(storeDir: string, record: StoredTransfer): void {
  fs.mkdirSync(transferDir(storeDir), { recursive: true, mode: 0o700 });
  const target = transferPath(storeDir, record.idempotencyKey);
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(record, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temp, target);
}

function claimTransfer(
  storeDir: string,
  input: CustodyTransferInput,
  ledgerOwner: string,
  digest: string,
): { record: StoredTransfer; inserted: boolean } {
  fs.mkdirSync(transferDir(storeDir), { recursive: true, mode: 0o700 });
  const now = new Date().toISOString();
  const record: StoredTransfer = {
    ...input,
    requestId: stableRequestId(input.idempotencyKey),
    intentDigest: digest,
    ledgerOwner,
    status: "in_doubt",
    createdAt: now,
    updatedAt: now,
  };

  try {
    fs.writeFileSync(
      transferPath(storeDir, input.idempotencyKey),
      JSON.stringify(record, null, 2),
      { flag: "wx", mode: 0o600 },
    );
    return { record, inserted: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

    const existing = readTransfer(storeDir, input.idempotencyKey);
    if (
      existing.intentDigest !== digest ||
      existing.ledgerOwner !== ledgerOwner
    ) {
      throw new CustodyTransferConflict(
        "idempotency key already belongs to another custody transfer",
      );
    }
    return { record: existing, inserted: false };
  }
}

function result(record: StoredTransfer): CustodyTransferResponse {
  return {
    status: record.status,
    requestId: record.requestId,
    amountMinor: record.amountMinor,
    ...(record.signature ? { signature: record.signature } : {}),
  };
}

function base58(bytes: Uint8Array): string {
  const alphabet =
    "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

  let digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      const value = digits[i] * 256 + carry;
      digits[i] = value % 58;
      carry = Math.floor(value / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;

  return (
    "1".repeat(zeroes) +
    digits
      .reverse()
      .map((d) => alphabet[d])
      .join("")
  );
}

function loadOperator(env: NodeJS.ProcessEnv): Keypair {
  const raw = env.SOLANA_OPERATOR_KEYPAIR_JSON;
  if (!raw) throw new Error("SOLANA_OPERATOR_KEYPAIR_JSON not set");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("SOLANA_OPERATOR_KEYPAIR_JSON must be a JSON byte array");
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length !== 64 ||
    parsed.some(
      (value) =>
        !Number.isInteger(value) || Number(value) < 0 || Number(value) > 255,
    )
  ) {
    throw new Error("SOLANA_OPERATOR_KEYPAIR_JSON must contain 64 bytes");
  }

  return Keypair.fromSecretKey(Uint8Array.from(parsed as number[]));
}

export class CustodyTransferService {
  private walletLookup: (storeDir: string, userId: string) => string | null;
  private signer: NonNullable<CustodyTransferDeps["withUserKeypair"]>;
  private deposits: DepositLedger;
  private spends: SpendLedger;
  private env: NodeJS.ProcessEnv;

  constructor(private deps: CustodyTransferDeps) {
    this.walletLookup = deps.walletAddressFor ?? walletAddressFor;
    this.signer = deps.withUserKeypair ?? withUserKeypair;
    this.deposits = new DepositLedger(deps.storeDir);
    this.spends = new SpendLedger(deps.storeDir);
    this.env = deps.env ?? process.env;
  }

  private spendable(ledgerOwner: string): bigint {
    return (
      this.deposits.balanceBaseUnits(ledgerOwner) -
      this.spends.spentBaseUnits(ledgerOwner)
    );
  }

  private setSpendState(
    ledgerOwner: string,
    key: string,
    state: SpendState,
  ): void {
    this.spends.setState(ledgerOwner, key, state);
  }

  private reserve(
    ledgerOwner: string,
    input: CustodyTransferInput,
    amount: bigint,
    digest: string,
  ): void {
    const existing = this.spends.get(ledgerOwner, input.idempotencyKey);

    if (existing) {
      if (existing.requestFingerprint !== digest) {
        throw new CustodyTransferConflict(
          "idempotency key already belongs to another debit",
        );
      }
      return;
    }

    const reserved = this.spends.spend(
      {
        owner: ledgerOwner,
        idempotencyKey: input.idempotencyKey,
        paidBaseUnits: amount,
        costBaseUnits: amount,
        reason: "merchant custody transfer",
        requestFingerprint: digest,
      },
      this.spendable(ledgerOwner),
    );

    if (reserved.record.requestFingerprint !== digest) {
      throw new CustodyTransferConflict(
        "idempotency key already belongs to another debit",
      );
    }

    this.spends.setState(ledgerOwner, input.idempotencyKey, "IN_DOUBT");
  }

  async transfer(
    input: CustodyTransferInput,
  ): Promise<CustodyTransferResponse> {
    if (input.asset !== "USDC" || input.network !== "SOLANA") {
      throw new Error("unsupported custody asset or network");
    }
    if (!input.owner || !input.idempotencyKey) {
      throw new Error("owner and idempotencyKey are required");
    }

    const amount = positive(input.amountMinor, "amountMinor");
    const maxDebit = positive(input.maxDebitMinor, "maxDebitMinor");
    if (amount > maxDebit) {
      throw new Error("amountMinor exceeds maxDebitMinor");
    }

    const destination = new PublicKey(input.destination);
    const ownerAddress = this.walletLookup(this.deps.storeDir, input.owner);
    if (!ownerAddress) throw new Error("owner wallet not provisioned");

    const ownerKey = new PublicKey(ownerAddress);
    if (ownerKey.equals(destination)) {
      throw new Error("destination must differ from owner wallet");
    }

    const digest = intentDigest(input);

    const existingFile = transferPath(
      this.deps.storeDir,
      input.idempotencyKey,
    );

    if (fs.existsSync(existingFile)) {
      const existing = readTransfer(
        this.deps.storeDir,
        input.idempotencyKey,
      );

      if (
        existing.intentDigest !== digest ||
        existing.ledgerOwner !== ownerAddress
      ) {
        throw new CustodyTransferConflict(
          "idempotency key already belongs to another custody transfer",
        );
      }

      return this.reconcile(existing);
    }

    const claimed = claimTransfer(
      this.deps.storeDir,
      input,
      ownerAddress,
      digest,
    );

    if (!claimed.inserted) return this.reconcile(claimed.record);

    try {
      // These two operations are synchronous and adjacent. In the current
      // single-writer payments process there is no await between balance
      // calculation and the durable spend record.
      this.reserve(ownerAddress, input, amount, digest);
    } catch (error) {
      const failed: StoredTransfer = {
        ...claimed.record,
        status: "failed",
        error: (error as Error).message,
        updatedAt: new Date().toISOString(),
      };
      writeTransfer(this.deps.storeDir, failed);
      throw error;
    }

    let current = claimed.record;

    try {
      const block = await this.deps.connection.getLatestBlockhash(
        this.deps.commitment,
      );

      await this.signer(
        this.deps.storeDir,
        input.owner,
        async (user) => {
          if (!user.publicKey.equals(ownerKey)) {
            throw new Error("custody wallet identity mismatch");
          }

          const sourceAta = getAssociatedTokenAddressSync(
            this.deps.mint,
            user.publicKey,
          );
          const destinationAta = getAssociatedTokenAddressSync(
            this.deps.mint,
            destination,
            true,
          );

          const tx = new Transaction();
          tx.feePayer = this.deps.operator.publicKey;
          tx.recentBlockhash = block.blockhash;

          tx.add(
            createAssociatedTokenAccountIdempotentInstruction(
              this.deps.operator.publicKey,
              destinationAta,
              destination,
              this.deps.mint,
            ),
          );

          tx.add(
            createTransferCheckedInstruction(
              sourceAta,
              this.deps.mint,
              destinationAta,
              user.publicKey,
              amount,
              6,
            ),
          );

          tx.sign(this.deps.operator, user);

          if (!tx.signature) {
            throw new Error("signed transaction has no signature");
          }

          const signature = base58(tx.signature);
          const raw = tx.serialize();

          current = {
            ...current,
            status: "in_doubt",
            signature,
            blockhash: block.blockhash,
            lastValidBlockHeight: block.lastValidBlockHeight,
            updatedAt: new Date().toISOString(),
          };

          // Persist the immutable transaction identity before touching RPC.
          writeTransfer(this.deps.storeDir, current);

          let returned: string;
          try {
            returned = await this.deps.connection.sendRawTransaction(raw, {
              skipPreflight: false,
              maxRetries: 0,
            });
          } catch (error) {
            current = {
              ...current,
              status: "in_doubt",
              error: (error as Error).message,
              updatedAt: new Date().toISOString(),
            };
            writeTransfer(this.deps.storeDir, current);
            this.setSpendState(
              ownerAddress,
              input.idempotencyKey,
              "IN_DOUBT",
            );
            return;
          }

          if (returned !== signature) {
            current = {
              ...current,
              status: "in_doubt",
              error: "rpc returned a different transaction signature",
              updatedAt: new Date().toISOString(),
            };
            writeTransfer(this.deps.storeDir, current);
            this.setSpendState(
              ownerAddress,
              input.idempotencyKey,
              "IN_DOUBT",
            );
            return;
          }

          current = {
            ...current,
            status: "pending",
            broadcastAcceptedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          };
          writeTransfer(this.deps.storeDir, current);
          this.setSpendState(
            ownerAddress,
            input.idempotencyKey,
            "PENDING",
          );
        },
        this.env,
      );
    } catch (error) {
      if (!current.signature) {
        this.setSpendState(
          ownerAddress,
          input.idempotencyKey,
          "RELEASED",
        );
      } else {
        this.setSpendState(
          ownerAddress,
          input.idempotencyKey,
          "IN_DOUBT",
        );
      }

      current = {
        ...current,
        status: current.signature ? "in_doubt" : "failed",
        error: (error as Error).message,
        updatedAt: new Date().toISOString(),
      };
      writeTransfer(this.deps.storeDir, current);
    }

    return result(
      readTransfer(this.deps.storeDir, input.idempotencyKey),
    );
  }

  async status(idempotencyKey: string): Promise<CustodyTransferResponse> {
    return this.reconcile(
      readTransfer(this.deps.storeDir, idempotencyKey),
    );
  }

  private async reconcile(
    record: StoredTransfer,
  ): Promise<CustodyTransferResponse> {
    if (!record.signature) {
      if (record.status === "failed") return result(record);

      const debit = this.spends.get(
        record.ledgerOwner,
        record.idempotencyKey,
      );

      if (!debit) {
        const failed: StoredTransfer = {
          ...record,
          status: "failed",
          error: "custody debit reservation missing",
          updatedAt: new Date().toISOString(),
        };
        writeTransfer(this.deps.storeDir, failed);
        return result(failed);
      }

      this.setSpendState(
        record.ledgerOwner,
        record.idempotencyKey,
        "IN_DOUBT",
      );

      const next: StoredTransfer = {
        ...record,
        status: "in_doubt",
        updatedAt: new Date().toISOString(),
      };
      writeTransfer(this.deps.storeDir, next);
      return result(next);
    }

    let chainStatus: {
      err: unknown;
      confirmationStatus?: "processed" | "confirmed" | "finalized" | null;
    } | null;

    try {
      chainStatus = (
        await this.deps.connection.getSignatureStatuses(
          [record.signature],
          { searchTransactionHistory: true },
        )
      ).value[0];
    } catch (error) {
      this.setSpendState(
        record.ledgerOwner,
        record.idempotencyKey,
        "IN_DOUBT",
      );

      const next: StoredTransfer = {
        ...record,
        status: "in_doubt",
        error: (error as Error).message,
        updatedAt: new Date().toISOString(),
      };
      writeTransfer(this.deps.storeDir, next);
      return result(next);
    }

    if (!chainStatus) {
      this.setSpendState(
        record.ledgerOwner,
        record.idempotencyKey,
        "IN_DOUBT",
      );

      const next: StoredTransfer = {
        ...record,
        status: "in_doubt",
        updatedAt: new Date().toISOString(),
      };
      writeTransfer(this.deps.storeDir, next);
      return result(next);
    }

    if (chainStatus.confirmationStatus !== "finalized") {
      this.setSpendState(
        record.ledgerOwner,
        record.idempotencyKey,
        "PENDING",
      );

      const next: StoredTransfer = {
        ...record,
        status: "pending",
        updatedAt: new Date().toISOString(),
      };
      writeTransfer(this.deps.storeDir, next);
      return result(next);
    }

    if (chainStatus.err) {
      this.setSpendState(
        record.ledgerOwner,
        record.idempotencyKey,
        "REVERSED",
      );

      const next: StoredTransfer = {
        ...record,
        status: "failed",
        updatedAt: new Date().toISOString(),
      };
      writeTransfer(this.deps.storeDir, next);
      return result(next);
    }

    this.setSpendState(
      record.ledgerOwner,
      record.idempotencyKey,
      "SETTLED",
    );

    const next: StoredTransfer = {
      ...record,
      status: "settled",
      updatedAt: new Date().toISOString(),
    };
    writeTransfer(this.deps.storeDir, next);
    return result(next);
  }
}

export function custodyTransferFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CustodyTransferService {
  const cfg = loadFundingConfig(env);

  return new CustodyTransferService({
    connection: new Connection(cfg.rpcUrl, cfg.commitment),
    storeDir: fundingStoreDir(env),
    mint: new PublicKey(cfg.usdcMint),
    commitment: cfg.commitment,
    operator: loadOperator(env),
    env,
  });
}
