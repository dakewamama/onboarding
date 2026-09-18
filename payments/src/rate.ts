/**
 * NGN <-> USDC conversion for pricing. The rate is OPERATOR-CONFIGURED
 * (AXIS_USDC_NGN_RATE = NGN per 1 USDC) — real, deterministic data, never a
 * model-originated number. Fail-closed: unset/invalid throws at point of use, so
 * a purchase can't be priced against a missing rate. (Swap for a live feed later;
 * the caller contract stays identical.)
 */

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
