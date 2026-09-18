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
  now: Date = new Date(),
  suffix: string = Math.random().toString(36).slice(2, 12),
): string {
  const lagos = new Date(now.getTime() + 60 * 60 * 1000); // UTC+1
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${lagos.getUTCFullYear()}${p(lagos.getUTCMonth() + 1)}${p(lagos.getUTCDate())}` +
    `${p(lagos.getUTCHours())}${p(lagos.getUTCMinutes())}`;
  return `${stamp}${suffix}`;
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
  const j = (json ?? {}) as Record<string, any>;
  const tx = (j.content?.transactions ?? {}) as Record<string, any>;
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
    requestId?: string;
  }): Promise<AirtimeResult> {
    const serviceID = serviceIdFor(params.network);
    if (!serviceID) throw new Error(`unsupported network: ${params.network}`);
    if (!(params.amount > 0)) throw new Error("amount must be positive");

    const res = await fetch(`${this.base()}/pay`, {
      method: "POST",
      headers: {
        "api-key": this.cfg.apiKey,
        "secret-key": this.cfg.secretKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        request_id: params.requestId ?? buildRequestId(),
        serviceID,
        amount: params.amount,
        phone: params.phone,
      }),
    });
    const json = await res.json().catch(() => ({}));
    return parseVtpassResult(json);
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
