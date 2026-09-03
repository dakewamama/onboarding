import * as crypto from "crypto";

/**
 * Paj v2 webhook signature verification (docs.paj.cash/concepts/webhook-signatures).
 *
 * Headers:
 *   X-PAJ-Timestamp : unix seconds when signed
 *   X-PAJ-Signature : "v1={hex_digest}"
 *
 * Digest: HMAC-SHA256 over the exact string `{timestamp}.{raw body}` using the
 * API key's webhookSecret (`whsec_...`), hex encoded. Stale timestamps are
 * rejected to block replays. The single biggest failure mode is verifying a
 * re-serialised body instead of the raw bytes, so callers MUST pass the raw
 * request body exactly as received, before any JSON.parse.
 */

export interface WebhookVerifyResult {
  valid: boolean;
  reason?: string;
}

export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  timestampHeader: string | undefined,
  secret: string,
  toleranceSeconds = 300,
  now: () => number = () => Math.floor(Date.now() / 1000)
): WebhookVerifyResult {
  if (!secret) return { valid: false, reason: "no webhook secret configured" };
  if (!signatureHeader) return { valid: false, reason: "missing signature header" };
  if (!timestampHeader) return { valid: false, reason: "missing timestamp header" };

  const ts = Number(timestampHeader);
  if (!Number.isFinite(ts)) return { valid: false, reason: "invalid timestamp" };
  if (Math.abs(now() - ts) > toleranceSeconds) {
    return { valid: false, reason: "timestamp outside tolerance (replay?)" };
  }

  const match = /^v1=([0-9a-f]+)$/i.exec(signatureHeader.trim());
  if (!match) return { valid: false, reason: "malformed signature header" };
  const provided = Buffer.from(match[1], "hex");

  // Sign with the timestamp string exactly as received on the wire.
  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestampHeader}.${rawBody}`)
    .digest();

  if (provided.length !== expected.length) {
    return { valid: false, reason: "signature length mismatch" };
  }
  const valid = crypto.timingSafeEqual(provided, expected);
  return valid ? { valid: true } : { valid: false, reason: "signature mismatch" };
}

/** Test-only helper: produce a valid `v1=` signature for a body + timestamp. */
export function signWebhook(rawBody: string, timestamp: number, secret: string): string {
  const digest = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return `v1=${digest}`;
}
