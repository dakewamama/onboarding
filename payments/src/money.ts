// Money helpers. Rule: decimal strings at the module boundary, integer base
// units (bigint) internally, never a float in the math.

export const USDC_DECIMALS = 6;

/** Parse a decimal string ("33.11") into integer base units (bigint). */
export function toBaseUnits(decimal: string, decimals = USDC_DECIMALS): bigint {
  const s = decimal.trim();
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`invalid decimal amount: "${decimal}"`);
  }
  const [whole, frac = ""] = s.split(".");
  if (frac.length > decimals) {
    throw new Error(`amount "${decimal}" has more than ${decimals} decimal places`);
  }
  const scaled = frac.padEnd(decimals, "0");
  return BigInt(whole) * BigInt(10) ** BigInt(decimals) + BigInt(scaled || "0");
}

/** Render integer base units back to a canonical decimal string. */
export function fromBaseUnits(base: bigint, decimals = USDC_DECIMALS): string {
  const negative = base < BigInt(0);
  const abs = negative ? -base : base;
  const divisor = BigInt(10) ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = (abs % divisor).toString().padStart(decimals, "0").replace(/0+$/, "");
  const out = frac ? `${whole}.${frac}` : `${whole}`;
  return negative ? `-${out}` : out;
}

/** Paj's wire format is a decimal number (33.11), not base units. Derive it from
 *  the canonical base-unit value so we never transmit a drifted float. */
export function toWireAmount(base: bigint, decimals = USDC_DECIMALS): number {
  return Number(fromBaseUnits(base, decimals));
}
