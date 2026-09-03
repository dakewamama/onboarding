// Public types for the Paj payment module (v2). This is an off-chain layer; it
// has nothing to do with the Anchor program.

export type Chain = "SOLANA" | "MONAD" | "ETHEREUM" | "BSC" | "ZCASH";
export type Currency = "NGN" | "GHS" | "TZS" | "KES" | "ZAR" | "USD";

/** OFFRAMP = crypto -> naira payout to a bank account (POST /pub/v2/offramp).
 *  PAYMENT = collect USDC to a deposit address, no bank payout (POST /pub/v2/payment, method=TOKEN). */
export type PaymentMode = "OFFRAMP" | "PAYMENT";

/** Where an off-ramp pays the naira out. Required in OFFRAMP mode. */
export interface BankDestination {
  bankCode: string;
  accountNumber: string;
  currency?: Currency; // defaults to config currency
  saveBeneficiary?: boolean;
  description?: string;
}

/** PAYMENT mode has no bank payout; recipient is a caller-side reference only. */
export interface PaymentRecipient {
  ref?: string;
}

export type Recipient = BankDestination | PaymentRecipient;

export interface CreatePaymentRequest {
  /** Your order id. Paj has no metadata field, so we map orderReference -> pajId locally. */
  orderReference: string;
  /** Decimal string, e.g. "33.11". Never a float. */
  amountUsdc: string;
  recipient: Recipient;
  /** Optional per-order webhook override; v2 also supports account-level webhooks. */
  webhookUrl?: string;
}

export interface CreatePaymentResult {
  pajId: string;
  depositAddress: string;
}

export interface Settlement {
  pajId: string;
  /** Your orderReference, resolved from pajId; null if we never saw the creation. */
  reference: string | null;
  /** Decimal string. */
  amountUsdc: string;
  /** True only for a confirmed terminal success. */
  success: boolean;
  /** True if success or a terminal failure (so non-terminal updates can be ignored). */
  terminal: boolean;
  /** Raw Paj status, preserved for logging/audit. */
  status: string;
}

export interface PaymentProvider {
  createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult>;
  /** v2 signs `{timestamp}.{rawBody}`, so both header values are required. */
  verifyWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
    timestampHeader: string | undefined
  ): boolean;
  confirmSettled(pajId: string): Promise<boolean>;
  parseSettlement(rawBody: string): Settlement;
}
