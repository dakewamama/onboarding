import { PajConfig } from "./config";
import { PajClient } from "./pajClient";
import { PaymentStore } from "./store";
import { verifyWebhookSignature } from "./webhook";
import { isSuccess, isTerminal } from "./status";
import { fromBaseUnits, toBaseUnits, toWireAmount } from "./money";
import {
  BankDestination,
  CreatePaymentRequest,
  CreatePaymentResult,
  PaymentProvider,
  Settlement,
} from "./types";

/**
 * Paj v2 implementation of PaymentProvider. Supports both modes, chosen by
 * config.mode:
 *   OFFRAMP -> POST /pub/v2/offramp (crypto -> naira bank payout), settles on rampWebhookURL
 *   PAYMENT -> POST /pub/v2/payment method=TOKEN (collect USDC), settles on paymentWebhookURL
 */
export class PajProvider implements PaymentProvider {
  constructor(
    private cfg: PajConfig,
    private client: PajClient = new PajClient(cfg),
    private store: PaymentStore = new PaymentStore(cfg.storeDir)
  ) {}

  async createPayment(req: CreatePaymentRequest): Promise<CreatePaymentResult> {
    const amount = toWireAmount(toBaseUnits(req.amountUsdc));

    let pajId: string;
    let depositAddress: string | undefined;

    if (this.cfg.mode === "OFFRAMP") {
      const dest = req.recipient as BankDestination;
      if (!dest || !dest.bankCode || !dest.accountNumber) {
        throw new Error(
          "OFFRAMP mode requires recipient { bankCode, accountNumber }"
        );
      }
      const res = await this.client.createOfframp({
        accountNumber: dest.accountNumber,
        bankCode: dest.bankCode,
        currency: dest.currency ?? this.cfg.currency,
        mint: this.cfg.mint,
        chain: this.cfg.chain,
        amount,
        webhookURL: req.webhookUrl ?? this.cfg.webhookUrl,
        saveBeneficiary: dest.saveBeneficiary,
        description: dest.description,
        businessUSDCFee: this.cfg.businessUsdcFee,
      });
      pajId = res.id;
      depositAddress = res.address;
    } else {
      const res = await this.client.createPayment({
        amount,
        method: "TOKEN",
        chain: this.cfg.chain,
        mint: this.cfg.mint,
      });
      pajId = res.id;
      depositAddress = res.token?.address ?? res.address;
    }

    if (!pajId) throw new Error("Paj response missing id");
    if (!depositAddress) throw new Error("Paj response missing deposit address");

    // Correlate immediately; the webhook only carries Paj's id.
    this.store.link(req.orderReference, pajId);
    return { pajId, depositAddress };
  }

  verifyWebhook(
    rawBody: string,
    signatureHeader: string | undefined,
    timestampHeader: string | undefined
  ): boolean {
    return verifyWebhookSignature(
      rawBody,
      signatureHeader,
      timestampHeader,
      this.cfg.webhookSecret
    ).valid;
  }

  /**
   * v2 exposes no status GET endpoint (confirmed in openapi.json and the
   * create-payment docs: "you do not have to poll"). So the confirmed-settled
   * state is "we received and signature-verified a SUCCESSFUL webhook for this
   * pajId" — recorded in the store. The signature IS Paj's cryptographic
   * confirmation, which is the belt-and-braces v1 lacked. If Paj later exposes a
   * private status endpoint, add a real re-fetch here.
   */
  async confirmSettled(pajId: string): Promise<boolean> {
    return this.store.isSettled(pajId);
  }

  parseSettlement(rawBody: string): Settlement {
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    const pajId = String(body.id ?? "");
    const status = String(body.status ?? "");

    return {
      pajId,
      reference: pajId ? this.store.orderReferenceFor(pajId) : null,
      amountUsdc: extractUsdc(body),
      success: isSuccess(status),
      terminal: isTerminal(status),
      status,
    };
  }

  // --- helpers used by the webhook handler (not part of the interface) ---

  /** Atomic, idempotent. True if this call recorded the settlement, false if a
   *  duplicate. Credit exactly when this returns true. */
  markSettled(settlement: Settlement): boolean {
    return this.store.markSettled(settlement.pajId, settlement);
  }
}

// Pick the USDC amount defensively across offramp/payment payload shapes.
function extractUsdc(body: Record<string, unknown>): string {
  const candidates = [body.usdcAmount, body.amount, (body.token as any)?.amount];
  for (const c of candidates) {
    if (c != null && c !== "") {
      // Values arrive as decimal; round-trip through base units to canonicalise.
      return fromBaseUnits(toBaseUnits(String(c)));
    }
  }
  return "0";
}
