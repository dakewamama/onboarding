/**
 * Live SOL -> USDC price, used to value a native-SOL deposit into the USDC-
 * denominated ledger. Real market data only — never a model-originated number.
 *
 * Fail-closed: if we can't get a sane price, we throw and the watcher simply does
 * NOT credit that deposit this poll (it retries next poll). Better to leave a
 * deposit briefly uncredited than to credit a wrong amount of money.
 *
 * A fixed SOL_USDC_PRICE env overrides the network fetch (useful for tests and as
 * a manual break-glass). Otherwise we fetch from SOL_PRICE_URL (default
 * Coingecko simple price) and read the value at SOL_PRICE_JSON_PATH.
 */

// Sanity bounds. A price outside this range is treated as an oracle glitch and
// rejected rather than used to credit money.
const MIN_PRICE = 1;
const MAX_PRICE = 100_000;

const DEFAULT_URL =
  "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd";
const DEFAULT_PATH = "solana.usd";

function readPath(obj: unknown, dotted: string): unknown {
  return dotted
    .split(".")
    .reduce<unknown>((acc, k) => (acc == null ? acc : (acc as Record<string, unknown>)[k]), obj);
}

function sane(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  if (!Number.isFinite(v) || v < MIN_PRICE || v > MAX_PRICE) {
    throw new Error(`SOL price out of sane range: ${String(n)}`);
  }
  return v;
}

/** USDC per 1 SOL. Throws on any failure (fail-closed). */
export async function solUsdcPrice(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = 8000,
): Promise<number> {
  const fixed = env.SOL_USDC_PRICE;
  if (fixed) return sane(fixed);

  const url = env.SOL_PRICE_URL ?? DEFAULT_URL;
  const jsonPath = env.SOL_PRICE_JSON_PATH ?? DEFAULT_PATH;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`price fetch ${res.status}`);
    const body = (await res.json()) as unknown;
    return sane(readPath(body, jsonPath));
  } finally {
    clearTimeout(t);
  }
}
