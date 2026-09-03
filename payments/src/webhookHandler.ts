import { PajProvider } from "./pajProvider";
import { Settlement } from "./types";

export interface HandleResult {
  status: number; // HTTP status to return to Paj
  note: string;
  settlement?: Settlement;
  credited: boolean;
}

/**
 * The full inbound-webhook pipeline:
 *   1. verify the signature over the RAW body (reject if invalid)
 *   2. parse and normalise the status
 *   3. ignore non-terminal updates; log terminal failures
 *   4. on terminal success, mark settled atomically and credit EXACTLY once
 *
 * `onCredit` is only ever invoked for a fresh, signature-verified, successful
 * settlement. Returning a 200 for already-handled duplicates keeps Paj from
 * retrying forever.
 */
export async function handleWebhook(
  provider: PajProvider,
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  onCredit: (s: Settlement) => Promise<void> | void
): Promise<HandleResult> {
  const signature = header(headers, "x-paj-signature");
  const timestamp = header(headers, "x-paj-timestamp");

  if (!provider.verifyWebhook(rawBody, signature, timestamp)) {
    return { status: 400, note: "invalid signature", credited: false };
  }

  const settlement = provider.parseSettlement(rawBody);

  if (!settlement.terminal) {
    return {
      status: 200,
      note: `ignored non-terminal status ${settlement.status}`,
      settlement,
      credited: false,
    };
  }

  if (!settlement.success) {
    return {
      status: 200,
      note: `terminal failure ${settlement.status}`,
      settlement,
      credited: false,
    };
  }

  // Only credit orders we actually created. A signed webhook for an unknown id
  // (Paj's test-webhook sample, or anything we have no record of) is acknowledged
  // with 200 so Paj stops retrying, but never triggers a credit.
  if (settlement.reference === null) {
    return {
      status: 200,
      note: `acknowledged; unknown pajId ${settlement.pajId}, not credited`,
      settlement,
      credited: false,
    };
  }

  const fresh = provider.markSettled(settlement);
  if (!fresh) {
    return {
      status: 200,
      note: "duplicate; already settled",
      settlement,
      credited: false,
    };
  }

  await onCredit(settlement);
  return { status: 200, note: "settled and credited", settlement, credited: true };
}

function header(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}
