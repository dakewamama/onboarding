import { createHash } from "crypto";
import type { AirtimeResult } from "./vtpassClient";
import { requestIdForKey } from "./vtpassClient";
import type { SpendLedger, SpendRecord, SpendState } from "./funding/spendLedger";
import { ngnToUsdcBase } from "./rate";

export interface AirtimeFulfillDeps {
  getRate: () => Promise<number>;
  marginBps: number;
  availableBaseUnits: (owner: string) => bigint;
  spend: SpendLedger["spend"];
  getSpend: SpendLedger["get"];
  findSpend: SpendLedger["findByKey"];
  setState: SpendLedger["setState"];
  buyAirtime: (p: { network: string; amount: number; phone: string; requestId: string }) => Promise<AirtimeResult>;
  requery: (requestId: string) => Promise<AirtimeResult>;
}

export interface AirtimeFulfillParams {
  owner: string;
  network: string;
  amount: number;
  phone: string;
  idempotencyKey: string;
}

export interface AirtimeFulfillResult {
  status: "delivered" | "pending" | "failed" | "in_doubt";
  moneyState: SpendState;
  chargedBaseUnits: string;
  remnantBaseUnits: string;
  requestId?: string;
}

export class AirtimeIdentityConflict extends Error {}

function providerId(record: SpendRecord): string | undefined {
  // Legacy debits did not persist a reproducible provider identity. Never invent one.
  return record.provider === "vtpass"
    ? requestIdForKey(JSON.stringify([record.owner, record.idempotencyKey]), new Date(record.at))
    : undefined;
}

function result(record: SpendRecord): AirtimeFulfillResult {
  const state = record.state ?? "IN_DOUBT";
  const released = state === "RELEASED" || state === "REVERSED";
  return {
    status: state === "SETTLED" ? "delivered" : released ? "failed" : state === "PENDING" ? "pending" : "in_doubt",
    moneyState: state,
    chargedBaseUnits: released ? "0" : record.paidBaseUnits,
    remnantBaseUnits: state === "SETTLED" ? record.remnantBaseUnits : "0",
    requestId: providerId(record),
  };
}

function apply(deps: AirtimeFulfillDeps, record: SpendRecord, delivery: AirtimeResult): AirtimeFulfillResult {
  let state: SpendState = "IN_DOUBT";
  // Unknown/malformed/duplicate codes are not proof of failure or success.
  const correlated = !delivery.requestId || delivery.requestId === providerId(record);
  if (correlated) {
    if (delivery.code === "000" && delivery.status === "delivered") state = "SETTLED";
    else if (delivery.status === "failed" && delivery.code === "016") state = "RELEASED";
    else if (delivery.status === "reversed" && delivery.code === "040") state = "REVERSED";
    else if (["pending", "initiated"].includes(delivery.status)) state = "PENDING";
  }
  return result(deps.setState(record.owner, record.idempotencyKey, state));
}

/** Reserve once, persist the action timestamp before /pay, and never replay /pay.
 * Retries return the stored verdict. Only status/requery reconciles uncertainty. */
export async function fulfillAirtime(deps: AirtimeFulfillDeps, params: AirtimeFulfillParams): Promise<AirtimeFulfillResult> {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify([params.owner, params.network.toLowerCase(), params.amount, params.phone])).digest("hex");
  const replay = (record: SpendRecord): AirtimeFulfillResult => {
    if (record.requestFingerprint && record.requestFingerprint !== fingerprint) {
      throw new AirtimeIdentityConflict("idempotency key already belongs to another purchase");
    }
    return result(record);
  };
  const existing = deps.getSpend(params.owner, params.idempotencyKey);
  if (existing) return replay(existing); // works even when rate/balance/provider are down
  const rate = await deps.getRate();
  const cost = ngnToUsdcBase(params.amount, rate);
  const paid = ngnToUsdcBase(params.amount * (1 + deps.marginBps / 10000), rate);
  const reserved = deps.spend({
    owner: params.owner, idempotencyKey: params.idempotencyKey,
    paidBaseUnits: paid, costBaseUnits: cost,
    reason: `airtime ${params.network} ${params.phone}`,
    provider: "vtpass", requestFingerprint: fingerprint,
  }, deps.availableBaseUnits(params.owner));
  if (reserved.duplicate) return replay(reserved.record);
  const requestId = providerId(reserved.record)!;
  let delivery: AirtimeResult;
  try {
    delivery = await deps.buyAirtime({ network: params.network, amount: params.amount, phone: params.phone, requestId });
  } catch {
    return result(deps.getSpend(params.owner, params.idempotencyKey)!); // initial IN_DOUBT debit stands
  }
  return apply(deps, reserved.record, delivery);
}

/** The service-token gate is at the HTTP boundary. No requery can create a debit. */
export async function requeryAirtime(deps: AirtimeFulfillDeps, key: string): Promise<AirtimeFulfillResult | null> {
  const record = deps.findSpend(key);
  if (!record) return null;
  if (["SETTLED", "RELEASED", "REVERSED"].includes(record.state ?? "")) return result(record);
  const requestId = providerId(record);
  if (!requestId) return result(record);
  let delivery: AirtimeResult;
  try {
    delivery = await deps.requery(requestId);
  } catch {
    return result(deps.setState(record.owner, key, "IN_DOUBT"));
  }
  if (delivery.requestId !== requestId) return result(deps.setState(record.owner, key, "IN_DOUBT"));
  return apply(deps, record, delivery);
}
