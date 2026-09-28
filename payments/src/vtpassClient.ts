import { createHash } from "crypto";

/**
 * VTpass client — the airtime fulfilment rail (stopgap until Airbills' USDC-on-
 * Solana API ships). This is the only place that talks to VTpass outbound with
 * the secret key. Real contract (https://www.vtpass.com/documentation):
 *
 *   POST {base}/pay   headers: api-key, secret-key
 *     body: { request_id, serviceID, amount, phone }
 *     success: code "000" AND content.transactions.status "delivered"
 *   GET  {base}/balance  headers: api-key, public-key
 *
 * No model is ever in this loop: the caller passes a validated network, amount,
 * and phone; deterministic code executes.
 */

export type VtpassEnv = "sandbox" | "live";

const BASE: Record<VtpassEnv, string> = {
  sandbox: "https://sandbox.vtpass.com/api",
  live: "https://vtpass.com/api",
};

export interface VtpassConfig {
  apiKey: string;
  secretKey: string;
  publicKey?: string;
  env: VtpassEnv;
}

// User-facing network name -> VTpass serviceID. 9mobile is "etisalat" at VTpass.
const SERVICE_IDS: Record<string, string> = {
  mtn: "mtn",
  glo: "glo",
  airtel: "airtel",
  "9mobile": "etisalat",
  "9 mobile": "etisalat",
  etisalat: "etisalat",
};

/** Map a network name to a VTpass serviceID, or null if unsupported. */
export function serviceIdFor(network: string): string | null {
  return SERVICE_IDS[network.trim().toLowerCase()] ?? null;
}

/**
 * VTpass requires request_id to begin with the current date-time in Africa/Lagos
 * (GMT+1, no DST), format YYYYMMDDHHmm, followed by unique characters. `now` and
 * `suffix` are injectable for deterministic tests.
 */
export function buildRequestId(
  now: Date,
  suffix: string,
): string {
  const lagos = new Date(now.getTime() + 60 * 60 * 1000); // UTC+1
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${lagos.getUTCFullYear()}${p(lagos.getUTCMonth() + 1)}${p(lagos.getUTCDate())}` +
    `${p(lagos.getUTCHours())}${p(lagos.getUTCMinutes())}`;
  return `${stamp}${suffix}`;
}

/** Derive from the stable action key AND its persisted creation time. Never
 * pass the retry clock: VTpass requires a Lagos timestamp prefix. */
export function requestIdForKey(idempotencyKey: string, createdAt: Date): string {
  if (!Number.isFinite(createdAt.getTime())) throw new Error("invalid action creation time");
  const suffix = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 32);
  return buildRequestId(createdAt, suffix);
}

export interface AirtimeResult {
  /** code "000" AND status "delivered". */
  success: boolean;
  /** delivered | pending | initiated | failed | unknown */
  status: string;
  code: string;
  description: string;
  transactionId?: string;
  requestId?: string;
  raw: unknown;
}

/** Parse a VTpass /pay response into a typed result. Pure + testable. */
export function parseVtpassResult(json: unknown): AirtimeResult {
  const object = (v: unknown): Record<string, unknown> =>
    v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
  const j = object(json);
  const tx = object(object(j.content).transactions);
  const code = String(j.code ?? "");
  const status = String(tx.status ?? "unknown");
  return {
    success: code === "000" && status === "delivered",
    status,
    code,
    description: String(j.response_description ?? ""),
    transactionId: tx.transactionId ? String(tx.transactionId) : undefined,
    requestId: j.requestId ? String(j.requestId) : undefined,
    raw: json,
  };
}

export class VtpassClient {
  constructor(private cfg: VtpassConfig) {}

  private base(): string {
    return BASE[this.cfg.env];
  }

  async buyAirtime(params: {
    network: string;
    amount: number;
    phone: string;
    requestId: string;
  }): Promise<AirtimeResult> {
    const serviceID = serviceIdFor(params.network);
    if (!serviceID) throw new Error(`unsupported network: ${params.network}`);
    if (!params.requestId) throw new Error("stable requestId required");
    if (!(params.amount > 0)) throw new Error("amount must be positive");

    const res = await fetch(`${this.base()}/pay`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "api-key": this.cfg.apiKey,
        "secret-key": this.cfg.secretKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request_id: params.requestId,
        serviceID,
        amount: params.amount,
        phone: params.phone,
      }),
    });
    const json = await res.json().catch(() => ({}));
    return !res.ok ? parseVtpassResult({}) : parseVtpassResult(json);
  }

  /** Query the original purchase; never submit a second /pay. */
  async requery(requestId: string): Promise<AirtimeResult> {
    const res = await fetch(`${this.base()}/requery`, {
      method: "POST",
      signal: AbortSignal.timeout(30_000),
      headers: {
        "api-key": this.cfg.apiKey,
        "secret-key": this.cfg.secretKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ request_id: requestId }),
    });
    const json: unknown = await res.json().catch(() => ({}));
    const result = !res.ok ? parseVtpassResult({}) : parseVtpassResult(json);
    // Missing/mismatched correlation cannot authorize a money transition.
    return result.requestId === requestId ? result : parseVtpassResult({});
  }

  /** Reseller wallet balance (NGN). Uses the GET-style public-key auth. */
  async balance(): Promise<unknown> {
    const res = await fetch(`${this.base()}/balance`, {
      method: "GET",
      headers: {
        "api-key": this.cfg.apiKey,
        ...(this.cfg.publicKey ? { "public-key": this.cfg.publicKey } : {}),
      },
    });
    return res.json().catch(() => ({}));
  }
}
