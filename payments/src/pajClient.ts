import { BASE_URLS, PajConfig } from "./config";
import { Chain, Currency } from "./types";

/**
 * Thin HTTP client over the Paj v2 REST API. Auth is API-key-only via the
 * `x-api-key` header (v2 dropped v1's OTP/session flow). Uses global fetch
 * (Node 18+).
 *
 * NOTE: the openapi.json types `currency` and `chain` on the offramp body as
 * objects/enum refs; v1 and the payment endpoint use bare string enum values.
 * We send string enum values here — verify against the live openapi.json if
 * offramp ever rejects them.
 */

export interface OfframpBody {
  accountNumber: string;
  bankCode: string;
  currency: Currency;
  mint: string;
  chain: Chain;
  amount?: number; // USDC decimal
  fiatAmount?: number; // fiat decimal, mutually exclusive with amount
  webhookURL?: string;
  saveBeneficiary?: boolean;
  description?: string;
  bvn?: string;
  businessUSDCFee?: number; // wire name; the v1 SDK called this `fee`
}

export interface PaymentBody {
  amount: number; // whole units
  method: "TOKEN" | "FIAT";
  chain?: Chain; // required for TOKEN
  mint?: string; // required for TOKEN
  currency?: Currency; // required for FIAT
}

export interface PajOrderResponse {
  id: string;
  address?: string; // offramp deposit address
  token?: { chain: Chain; mint: string; address: string }; // payment (TOKEN) deposit
  fiat?: { currency: Currency; accountNumber: string; accountName: string; bank: unknown };
  status?: string;
  [k: string]: unknown;
}

/**
 * A registered bank account and its PERMANENT deterministic on-chain address.
 * This is the correct v2 primitive (docs.paj.cash/concepts/bank-account-addresses):
 * register once, cache the address, then send USDC to it to pay out fiat.
 */
export interface PajBankAccount {
  id: string;
  accountName: string; // bank-verified; show to the user to confirm before paying
  accountNumber: string;
  bank: string;
  address: string;
}

export class PajClient {
  constructor(private cfg: Pick<PajConfig, "apiKey" | "env">) {}

  private async request<T>(
    method: string,
    pathname: string,
    body?: unknown,
    query?: Record<string, string | undefined>
  ): Promise<T> {
    const url = new URL(BASE_URLS[this.cfg.env] + pathname);
    if (query) {
      for (const [k, v] of Object.entries(query)) {
        if (v != null) url.searchParams.set(k, v);
      }
    }
    if (!this.cfg.apiKey) {
      throw new Error("PAJ_API_KEY is required for outbound Paj API calls");
    }
    const res = await fetch(url.toString(), {
      method,
      headers: {
        "x-api-key": this.cfg.apiKey,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Paj ${method} ${pathname} -> ${res.status}: ${text}`);
    }
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Register (idempotent) a bank account and get its PERMANENT deterministic
   * on-chain address. THE correct off-ramp primitive: register once, cache the
   * address + accountName, confirm the name with the user, then send USDC to the
   * address to pay out. Re-calling with the same details returns the same record.
   */
  registerBankAccount(body: {
    bankCode: string;
    accountNumber: string;
  }): Promise<PajBankAccount> {
    return this.request("POST", "/pub/v2/bank-account", body);
  }

  /**
   * @deprecated Per-order off-ramp with an expiring address — the shape where
   * funding is hardest. Use `registerBankAccount` + send USDC to the permanent
   * address instead. Kept only until the register-once payout path is wired end
   * to end (needs the custody signer). Do not build new callers on this.
   */
  createOfframp(body: OfframpBody): Promise<PajOrderResponse> {
    return this.request("POST", "/pub/v2/offramp", body);
  }

  createPayment(body: PaymentBody): Promise<PajOrderResponse> {
    return this.request("POST", "/pub/v2/payment", body);
  }

  updateWebhooks(body: {
    rampWebhookURL?: string;
    paymentWebhookURL?: string;
  }): Promise<{ rampWebhookURL?: string; paymentWebhookURL?: string }> {
    return this.request("PATCH", "/pub/v2/webhook", body);
  }

  testWebhook(type: "RAMP" | "PAYMENT" = "RAMP"): Promise<{
    url: string;
    delivered: boolean;
    durationMs: number;
    error?: string;
  }> {
    return this.request("POST", "/pub/v2/webhook/test", undefined, { type });
  }

  getBanks(filters?: {
    code?: string;
    name?: string;
    country?: string;
  }): Promise<unknown> {
    return this.request("GET", "/pub/v2/bank", undefined, filters);
  }

  getRate(currency: Currency): Promise<unknown> {
    return this.request("GET", "/pub/v2/rate", undefined, { currency });
  }

  resolveBankAccount(q: {
    accountNumber?: string;
    address?: string;
  }): Promise<unknown> {
    return this.request("GET", "/pub/v2/bank-account", undefined, q);
  }
}
