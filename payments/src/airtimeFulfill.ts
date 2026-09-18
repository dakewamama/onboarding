/**
 * Airtime fulfilment orchestration — the wiring that turns a request into a real
 * transaction: RESERVE the debit, DELIVER via VTpass, VOID the debit if delivery
 * hard-fails. Ordering follows the brief: reserve funds before delivering, and
 * never leave a charge standing for airtime that didn't go out. Idempotent on the
 * caller's key (a replay never double-charges or double-delivers).
 *
 * Pure of I/O: all effects are injected, so the money logic is unit-tested with
 * stubs. No model number anywhere — amounts are the user's, the rate is config.
 */
import type { AirtimeResult } from "./vtpassClient";
import type { SpendResult } from "./funding/spendLedger";
import { ngnToUsdcBase } from "./rate";

export interface AirtimeFulfillDeps {
  /** NGN per 1 USDC. */
  ngnPerUsdc: number;
  /** Axis markup over VTpass cost, in basis points (0 = charge cost only). */
  marginBps: number;
  availableBaseUnits: (owner: string) => bigint;
  spend: (
    input: {
      owner: string;
      idempotencyKey: string;
      paidBaseUnits: bigint;
      costBaseUnits: bigint;
      reason: string;
    },
    availableBaseUnits: bigint,
  ) => SpendResult;
  voidSpend: (owner: string, idempotencyKey: string) => boolean;
  buyAirtime: (p: {
    network: string;
    amount: number;
    phone: string;
  }) => Promise<AirtimeResult>;
}

export interface AirtimeFulfillParams {
  owner: string;
  network: string;
  amount: number; // NGN face value
  phone: string;
  idempotencyKey: string;
}

export interface AirtimeFulfillResult {
  status: "delivered" | "pending" | "failed" | "duplicate";
  chargedBaseUnits?: string;
  remnantBaseUnits?: string;
  delivery?: AirtimeResult;
}

export async function fulfillAirtime(
  deps: AirtimeFulfillDeps,
  params: AirtimeFulfillParams,
): Promise<AirtimeFulfillResult> {
  const costBase = ngnToUsdcBase(params.amount, deps.ngnPerUsdc);
  const paidNgn = params.amount * (1 + deps.marginBps / 10000);
  const paidBase = ngnToUsdcBase(paidNgn, deps.ngnPerUsdc);

  // 1) Reserve funds first (idempotent, balance-checked). Throws
  //    InsufficientBalanceError if the owner can't cover it.
  const available = deps.availableBaseUnits(params.owner);
  const res = deps.spend(
    {
      owner: params.owner,
      idempotencyKey: params.idempotencyKey,
      paidBaseUnits: paidBase,
      costBaseUnits: costBase,
      reason: `airtime ${params.network} ${params.phone}`,
    },
    available,
  );
  if (res.duplicate) {
    return {
      status: "duplicate",
      chargedBaseUnits: res.record.paidBaseUnits,
      remnantBaseUnits: res.record.remnantBaseUnits,
    };
  }

  // 2) Deliver. A thrown error or a hard failure releases the reservation so the
  //    user is never charged for airtime that didn't go out.
  let delivery: AirtimeResult;
  try {
    delivery = await deps.buyAirtime({
      network: params.network,
      amount: params.amount,
      phone: params.phone,
    });
  } catch (err) {
    deps.voidSpend(params.owner, params.idempotencyKey);
    throw err;
  }

  const accepted =
    delivery.success ||
    delivery.status === "pending" ||
    delivery.status === "initiated";
  if (!accepted) {
    deps.voidSpend(params.owner, params.idempotencyKey);
    return { status: "failed", delivery };
  }

  // 3) Delivered or pending: the charge stands; remnant is pool gain.
  return {
    status: delivery.success ? "delivered" : "pending",
    chargedBaseUnits: paidBase.toString(),
    remnantBaseUnits: (paidBase - costBase).toString(),
    delivery,
  };
}
