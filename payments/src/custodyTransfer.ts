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
import {
  InsufficientBalanceError,
} from "./funding/spendLedger";
import { openMoneyLedger, type MoneyLedger } from "./funding/moneyLedger";
import { openTransferStore, type TransferStore } from "./funding/transferStore";

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

export type CustodyMoneyState = "PENDING" | "IN_DOUBT" | "SETTLED" | "RELEASED" | "REVERSED";

export interface CustodyTransferResponse {
  status: CustodyTransferStatus;
  /** What happened to the user's funds. failed+RELEASED means nothing left the wallet. */
  moneyState: CustodyMoneyState;
  requestId: string;
  amountMinor: string;
  signature?: string;
  reason?: string;
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
  /** Why a failed transfer moved nothing: not_submitted, insufficient_balance, not_broadcast, expired. */
  reason?: string;
}

interface Chain {
  getLatestBlockhash(
    commitment?: "confirmed" | "finalized",
  ): Promise<{ blockhash: string; lastValidBlockHeight: number }>;

  sendRawTransaction(
    raw: Buffer | Uint8Array,
    options?: { skipPreflight?: boolean; maxRetries?: number },
  ): Promise<string>;

  getBlockHeight(commitment?: "confirmed" | "finalized"): Promise<number>;

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
  ledger?: MoneyLedger;
  transferStore?: TransferStore<StoredTransfer>;
  /** How long an unsigned claim may sit before it is treated as abandoned. */
  abandonAfterMs?: number;
}

export class CustodyTransferConflict extends Error {}
export class CustodyTransferNotFound extends Error {}

function positive(value: string, field: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${field} must be a positive integer string`);
  }
  return BigInt(value);
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

function moneyStateOf(record: StoredTransfer): CustodyMoneyState {
  if (record.status === "settled") return "SETTLED";
  if (record.status === "pending") return "PENDING";
  if (record.status === "in_doubt") return "IN_DOUBT";
  // A failure with a landed signature consumed fees; anything else never moved funds.
  return record.signature && !record.reason ? "REVERSED" : "RELEASED";
}

function result(record: StoredTransfer): CustodyTransferResponse {
  return {
    status: record.status,
    moneyState: moneyStateOf(record),
    requestId: record.requestId,
    amountMinor: record.amountMinor,
    ...(record.signature ? { signature: record.signature } : {}),
    ...(record.reason ? { reason: record.reason } : {}),
  };
}

const terminal = (r: StoredTransfer) => r.status === "settled" || r.status === "failed";

class TransferSuperseded extends Error {}

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
  private ledger: MoneyLedger;
  private store: TransferStore<StoredTransfer>;
  private env: NodeJS.ProcessEnv;

  constructor(private deps: CustodyTransferDeps) {
    this.walletLookup = deps.walletAddressFor ?? walletAddressFor;
    this.signer = deps.withUserKeypair ?? withUserKeypair;
    this.env = deps.env ?? process.env;
    this.ledger = deps.ledger ?? openMoneyLedger(this.env, deps.storeDir);
    this.store = deps.transferStore ?? openTransferStore<StoredTransfer>(this.ledger, deps.storeDir);
  }

  private async reserve(
    ledgerOwner: string,
    input: CustodyTransferInput,
    amount: bigint,
    digest: string,
  ): Promise<void> {
    const existing = await this.ledger.get(ledgerOwner, input.idempotencyKey);

    if (existing) {
      if (existing.requestFingerprint !== digest) {
        throw new CustodyTransferConflict(
          "idempotency key already belongs to another debit",
        );
      }
      // A reserve written before spends were created IN_DOUBT may have no state yet.
      if (!existing.state) await this.ledger.setState(ledgerOwner, input.idempotencyKey, "IN_DOUBT");
      return;
    }

    // The reserve and its IN_DOUBT state are one write: a crash cannot leave
    // money held with no state that reconciliation would pick up.
    const reserved = await this.ledger.spend(
      {
        owner: ledgerOwner,
        idempotencyKey: input.idempotencyKey,
        paidBaseUnits: amount,
        costBaseUnits: amount,
        reason: "merchant custody transfer",
        provider: "custody",
        requestFingerprint: digest,
      },
    );

    if (reserved.record.requestFingerprint !== digest) {
      throw new CustodyTransferConflict(
        "idempotency key already belongs to another debit",
      );
    }
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

    const existing = await this.store.read(input.idempotencyKey);

    if (existing) {
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

    const now = new Date().toISOString();
    const claimed = await this.store.claim({
      ...input,
      requestId: stableRequestId(input.idempotencyKey),
      intentDigest: digest,
      ledgerOwner: ownerAddress,
      status: "in_doubt",
      createdAt: now,
      updatedAt: now,
    });

    if (!claimed.inserted) {
      if (
        claimed.record.intentDigest !== digest ||
        claimed.record.ledgerOwner !== ownerAddress
      ) {
        throw new CustodyTransferConflict(
          "idempotency key already belongs to another custody transfer",
        );
      }
      return this.reconcile(claimed.record);
    }

    try {
      // Axis Money checks the balance and records the debit atomically.
      await this.reserve(ownerAddress, input, amount, digest);
    } catch (error) {
      // "not debited" only when the ledger holds no debit for this request.
      const debit = await this.ledger.get(ownerAddress, input.idempotencyKey).catch(() => undefined);
      const debited = debit === undefined || (debit !== null && debit.requestFingerprint === digest);
      const record: StoredTransfer = {
        ...claimed.record,
        status: debited ? "in_doubt" : "failed",
        error: (error as Error).message,
        reason: debited ? "reserve_unconfirmed" : error instanceof InsufficientBalanceError ? "insufficient_balance" : "not_debited",
        updatedAt: new Date().toISOString(),
      };
      await this.save(record);
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

          // Persist the immutable transaction identity before touching RPC. If a
          // reconcile already declared this claim abandoned, never broadcast.
          const persisted = current;
          if (!(await this.store.update(persisted, stored => !stored.signature && !terminal(stored)))) {
            throw new TransferSuperseded("custody transfer was abandoned before broadcast");
          }

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
            await this.save(current);
            await this.ledger.setState(
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
            await this.save(current);
            await this.ledger.setState(
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
          await this.save(current);
          await this.ledger.setState(
            ownerAddress,
            input.idempotencyKey,
            "PENDING",
          );
        },
        this.env,
      );
    } catch (error) {
      if (error instanceof TransferSuperseded) {
        // Abandoned before the signature was stored: nothing was broadcast.
        await this.ledger.setState(ownerAddress, input.idempotencyKey, "RELEASED");
        return result((await this.store.read(input.idempotencyKey))!);
      }
      if (!current.signature) {
        await this.ledger.setState(
          ownerAddress,
          input.idempotencyKey,
          "RELEASED",
        );
      } else {
        await this.ledger.setState(
          ownerAddress,
          input.idempotencyKey,
          "IN_DOUBT",
        );
      }

      current = {
        ...current,
        status: current.signature ? "in_doubt" : "failed",
        error: (error as Error).message,
        ...(current.signature ? {} : { reason: "not_broadcast" }),
        updatedAt: new Date().toISOString(),
      };
      await this.save(current);
    }

    return result((await this.store.read(input.idempotencyKey))!);
  }

  async status(idempotencyKey: string): Promise<CustodyTransferResponse> {
    const record = await this.store.read(idempotencyKey);
    if (record) return this.reconcile(record);
    // Never seen: void the key so a late request carrying it cannot claim it.
    const now = new Date().toISOString();
    const voided = await this.store.claim({
      owner: "", asset: "USDC", network: "SOLANA", destination: "", amountMinor: "0", maxDebitMinor: "0",
      idempotencyKey, requestId: stableRequestId(idempotencyKey), intentDigest: "", ledgerOwner: "",
      status: "failed", reason: "not_submitted", createdAt: now, updatedAt: now,
    });
    return voided.inserted ? result(voided.record) : this.reconcile(voided.record);
  }

  /** Persist and report; if a concurrent writer already finished the record, report that. */
  private async saved(next: StoredTransfer): Promise<CustodyTransferResponse> {
    if (await this.save(next)) return result(next);
    return result((await this.store.read(next.idempotencyKey))!);
  }

  /** Never overwrite a settled or failed record. */
  private async save(next: StoredTransfer): Promise<boolean> {
    return this.store.update(next, stored => !terminal(stored));
  }

  private async reconcile(
    record: StoredTransfer,
  ): Promise<CustodyTransferResponse> {
    // Settled and failed are final; the chain is not consulted again.
    if (terminal(record)) return result(record);
    if (!record.signature) {
      // The signature is persisted before any broadcast, so an unsigned claim has
      // moved nothing. Give a live transfer time to sign; after that, abandon it.
      const age = Date.now() - Date.parse(record.updatedAt);
      if (age < (this.deps.abandonAfterMs ?? 120_000)) return result(record);
      const abandoned: StoredTransfer = {
        ...record,
        status: "failed",
        reason: "not_broadcast",
        error: "abandoned before broadcast",
        updatedAt: new Date().toISOString(),
      };
      if (!(await this.store.update(abandoned, stored => !stored.signature && !terminal(stored)))) {
        return this.reconcile((await this.store.read(record.idempotencyKey))!);
      }
      if (await this.ledger.get(record.ledgerOwner, record.idempotencyKey)) {
        await this.ledger.setState(record.ledgerOwner, record.idempotencyKey, "RELEASED");
      }
      return result(abandoned);
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
      await this.ledger.setState(
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
      return this.saved(next);
    }

    if (!chainStatus && record.lastValidBlockHeight !== undefined) {
      // Past its last valid block height a transaction can never land. Once the
      // finalized chain is beyond it and the signature is still unknown, nothing moved.
      let expired = false;
      try {
        if ((await this.deps.connection.getBlockHeight("finalized")) > record.lastValidBlockHeight) {
          chainStatus = (await this.deps.connection.getSignatureStatuses([record.signature], { searchTransactionHistory: true })).value[0];
          expired = !chainStatus;
        }
      } catch {
        expired = false;
      }
      if (expired) {
        const failed: StoredTransfer = { ...record, status: "failed", reason: "expired", updatedAt: new Date().toISOString() };
        if (await this.save(failed)) await this.ledger.setState(record.ledgerOwner, record.idempotencyKey, "RELEASED");
        return result((await this.store.read(record.idempotencyKey))!);
      }
    }

    if (!chainStatus) {
      await this.ledger.setState(
        record.ledgerOwner,
        record.idempotencyKey,
        "IN_DOUBT",
      );

      const next: StoredTransfer = {
        ...record,
        status: "in_doubt",
        updatedAt: new Date().toISOString(),
      };
      return this.saved(next);
    }

    if (chainStatus.confirmationStatus !== "finalized") {
      await this.ledger.setState(
        record.ledgerOwner,
        record.idempotencyKey,
        "PENDING",
      );

      const next: StoredTransfer = {
        ...record,
        status: "pending",
        updatedAt: new Date().toISOString(),
      };
      return this.saved(next);
    }

    if (chainStatus.err) {
      await this.ledger.setState(
        record.ledgerOwner,
        record.idempotencyKey,
        "REVERSED",
      );

      const next: StoredTransfer = {
        ...record,
        status: "failed",
        updatedAt: new Date().toISOString(),
      };
      return this.saved(next);
    }

    await this.ledger.setState(
      record.ledgerOwner,
      record.idempotencyKey,
      "SETTLED",
    );

    const next: StoredTransfer = {
      ...record,
      status: "settled",
      updatedAt: new Date().toISOString(),
    };
    return this.saved(next);
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
