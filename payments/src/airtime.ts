import * as http from "http";
import { URL } from "url";
import { timingSafeEqual } from "crypto";
import { VtpassClient, VtpassEnv } from "./vtpassClient";
import { DepositLedger } from "./funding/depositLedger";
import { SpendLedger, InsufficientBalanceError } from "./funding/spendLedger";
import { fundingStoreDir } from "./funding/config";
import { usdcToNgnRate } from "./rate";
import { fulfillAirtime, AirtimeFulfillDeps } from "./airtimeFulfill";

/**
 * Authenticated airtime fulfilment, mounted next to the off-ramp + webhook
 * receiver. This is the ONLY place that talks to VTpass outbound with the secret
 * key. The brain calls it to buy airtime; it is gated by INTERNAL_API_TOKEN so
 * the public URL can't.
 *
 * It RESERVES the debit (SpendLedger, balance-checked + idempotent), DELIVERS via
 * VTpass, and VOIDS the debit if delivery hard-fails — so a user is never charged
 * for airtime that didn't go out. The remnant (paid − cost) is booked as pool
 * gain. Fail-closed: missing VTpass keys, token, or rate => 503.
 */
export interface AirtimeMount {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
  logStatus(port: number): void;
}

export function mountAirtime(env: NodeJS.ProcessEnv = process.env): AirtimeMount {
  const token = env.INTERNAL_API_TOKEN;
  const apiKey = env.VTPASS_API_KEY;
  const secretKey = env.VTPASS_SECRET_KEY;
  const publicKey = env.VTPASS_PUBLIC_KEY;
  const vtEnv: VtpassEnv = env.VTPASS_ENV === "live" ? "live" : "sandbox";
  const client =
    apiKey && secretKey
      ? new VtpassClient({ apiKey, secretKey, publicKey, env: vtEnv })
      : null;
  let ngnPerUsdc: number | null;
  try {
    ngnPerUsdc = usdcToNgnRate(env);
  } catch {
    ngnPerUsdc = null;
  }
  const marginBps = Number(env.AXIS_AIRTIME_MARGIN_BPS ?? 0) || 0;
  const enabled = Boolean(token && client && ngnPerUsdc);
  const disabledReason = !token
    ? "INTERNAL_API_TOKEN not set"
    : !client
      ? "VTPASS_API_KEY/VTPASS_SECRET_KEY not set"
      : !ngnPerUsdc
        ? "AXIS_USDC_NGN_RATE not set"
        : "";

  const storeDir = fundingStoreDir(env);
  const deposits = new DepositLedger(storeDir);
  const spends = new SpendLedger(storeDir);
  const deps: AirtimeFulfillDeps = {
    ngnPerUsdc: ngnPerUsdc ?? 0,
    marginBps,
    availableBaseUnits: (owner) =>
      deposits.balanceBaseUnits(owner) - spends.spentBaseUnits(owner),
    spend: (input, avail) => spends.spend(input, avail),
    voidSpend: (owner, key) => spends.void(owner, key),
    buyAirtime: (p) => client!.buyAirtime(p),
  };

  function authorized(req: http.IncomingMessage): boolean {
    const header = req.headers.authorization ?? "";
    const provided = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!token || !provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/airtime") return false;

    if (!enabled) return void send(res, 503, { error: disabledReason }), true;
    if (!authorized(req)) return void send(res, 401, { error: "unauthorized" }), true;
    if (req.method !== "POST") return void send(res, 405, { error: "method" }), true;

    try {
      const body = await readJson(req);
      const owner = String(body.owner ?? "");
      const network = String(body.network ?? "");
      const phone = String(body.phone ?? "");
      const idempotencyKey = String(body.idempotencyKey ?? "");
      const amount = body.amount != null ? Number(body.amount) : NaN;
      if (!owner || !network || !phone || !idempotencyKey || !(amount > 0)) {
        return (
          void send(res, 400, {
            error:
              "owner, network, phone, idempotencyKey and a positive amount are required",
          }),
          true
        );
      }
      const result = await fulfillAirtime(deps, {
        owner,
        network,
        amount,
        phone,
        idempotencyKey,
      });
      const status =
        result.status === "delivered" || result.status === "duplicate"
          ? 200
          : result.status === "pending"
            ? 202
            : 502; // failed
      return void send(res, status, result), true;
    } catch (err) {
      if (err instanceof InsufficientBalanceError) {
        return void send(res, 402, { error: "insufficient balance" }), true;
      }
      // Never leak the key; surface a generic error.
      console.error("[airtime] error", (err as Error).message);
      return void send(res, 502, { error: "airtime delivery failed" }), true;
    }
  }

  function logStatus(_port: number): void {
    console.log(
      enabled
        ? `[airtime] authenticated airtime route enabled (/airtime, VTpass ${vtEnv})`
        : `[airtime] disabled (${disabledReason})`,
    );
  }

  return { handle, logStatus };
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
