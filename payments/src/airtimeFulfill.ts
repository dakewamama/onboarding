/**
 * Airtime fulfilment orchestration — the wiring that turns a request into a real
 * transaction: RESERVE the debit, DELIVER via VTpass, VOID the debit ONLY on a
 * definitive hard failure. Idempotent on the caller's key (a replay never
 * double-charges or double-delivers), and the VTpass request_id is DERIVED from
 * that key, so a retry after an ambiguous outcome replays the same purchase
 * instead of buying twice.
 *
 * The honesty boundary (brief §MONEY): a network timeout is NOT a failure. If
 * delivery throws — DNS, timeout, reset — the provider may have accepted, so the
 * debit STANDS and the result is `in_doubt` for reconciliation. Only a parsed
 * VTpass rejection (status failed/rejected) voids the debit.
 *
 * Pure of I/O: all effects are injected, so the money logic is unit-tested with
 * stubs. No model number anywhere — amounts are the user's, the rate is config.
 */
import type { AirtimeResult } from "./vtpassClient";
import type { SpendResult } from "./funding/spendLedger";
import { ngnToUsdcBase } from "./rate";
import { requestIdForKey } from "./vtpassClient";

export interface AirtimeFulfillDeps {
  /** Resolve NGN per 1 USDC at buy time (Paj live rate, env fallback). */
  getRate: () => Promise<number>;
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
    requestId?: string;
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
  status: "delivered" | "pending" | "failed" | "duplicate" | "in_doubt";
  chargedBaseUnits?: string;
  remnantBaseUnits?: string;
  delivery?: AirtimeResult;
  /** The VTpass request_id used (reconciliation looks the purchase up by it). */
  requestId?: string;
}

export async function fulfillAirtime(
  deps: AirtimeFulfillDeps,
  params: AirtimeFulfillParams,
): Promise<AirtimeFulfillResult> {
  const ngnPerUsdc = await deps.getRate();
  const costBase = ngnToUsdcBase(params.amount, ngnPerUsdc);
  const paidNgn = params.amount * (1 + deps.marginBps / 10000);
  const paidBase = ngnToUsdcBase(paidNgn, ngnPerUsdc);
  // Same key in, same request_id out — the replay identity at the provider.
  const requestId = requestIdForKey(params.idempotencyKey);

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
      requestId,
    };
  }

  // 2) Deliver. A PARSED rejection is definitive: void the debit so the user is
  //    never charged for airtime that didn't go out. A THROWN error is NOT a
  //    rejection — the provider may have accepted, so the debit stands and the
  //    outcome is in_doubt until reconciliation gets a verdict.
  let delivery: AirtimeResult;
  try {
    delivery = await deps.buyAirtime({
      network: params.network,
      amount: params.amount,
      phone: params.phone,
      requestId,
    });
  } catch (err) {
    return {
      status: "in_doubt",
      chargedBaseUnits: paidBase.toString(),
      remnantBaseUnits: (paidBase - costBase).toString(),
      requestId,
    };
  }

  const accepted =
    delivery.success ||
    delivery.status === "pending" ||
    delivery.status === "initiated";
  if (!accepted) {
    deps.voidSpend(params.owner, params.idempotencyKey);
    return { status: "failed", delivery, requestId };
  }

  // 3) Delivered or pending: the charge stands; remnant is pool gain.
  return {
    status: delivery.success ? "delivered" : "pending",
    chargedBaseUnits: paidBase.toString(),
    remnantBaseUnits: (paidBase - costBase).toString(),
    delivery,
    requestId,
  };
}
