/**
 * NGN <-> USDC conversion for pricing. Real, deterministic data — never a
 * model-originated number. Preferred source is Paj's live off-ramp rate (our
 * settlement partner, so pricing stays consistent with what we actually get on
 * off-ramp; the rate already includes our business fee). AXIS_USDC_NGN_RATE is
 * only a fallback when Paj can't be reached.
 */

/** Shape of GET /pub/v2/rate — offRampRate.rate is NGN per USDC (crypto->fiat). */
export interface PajRateResponse {
  offRampRate?: { rate?: number };
  onRampRate?: { rate?: number };
}

/** Extract the USDC->NGN (off-ramp) rate, or null if absent/invalid. */
export function offRampNgnPerUsdc(r: PajRateResponse | null | undefined): number | null {
  const v = r?.offRampRate?.rate;
  return typeof v === "number" && v > 0 ? v : null;
}

/** Static fallback rate from env; throws when unset/invalid. */
export function usdcToNgnRate(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AXIS_USDC_NGN_RATE;
  const n = raw ? Number(raw) : NaN;
  if (!raw || !Number.isFinite(n) || n <= 0) {
    throw new Error("AXIS_USDC_NGN_RATE must be a positive number (NGN per USDC)");
  }
  return n;
}

/**
 * Convert an NGN amount to USDC base units (6 dp) at the given rate, rounding UP
 * so the pool is never short-changed. Airtime amounts are small, so float math on
 * `ngn / rate` stays well within safe-integer range after scaling.
 */
export function ngnToUsdcBase(ngn: number, ngnPerUsdc: number): bigint {
  if (!(ngn >= 0)) throw new Error("ngn must be >= 0");
  if (!(ngnPerUsdc > 0)) throw new Error("rate must be > 0");
  const usdc = ngn / ngnPerUsdc;
  return BigInt(Math.ceil(usdc * 1e6));
}
