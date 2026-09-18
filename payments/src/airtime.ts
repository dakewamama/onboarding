import * as http from "http";
import { URL } from "url";
import { timingSafeEqual } from "crypto";
import { VtpassClient, VtpassEnv } from "./vtpassClient";

/**
 * Authenticated airtime fulfilment, mounted next to the off-ramp + webhook
 * receiver. This is the ONLY place that talks to VTpass outbound with the secret
 * key. The brain calls it to deliver airtime; it is gated by INTERNAL_API_TOKEN
 * so the public URL can't.
 *
 * Fail-closed: if the VTpass keys or the internal token aren't set, every route
 * 503s. Deterministic: the caller passes a validated network, amount, and phone.
 *
 * NOTE: this rail DELIVERS airtime for a face amount. Charging the user and
 * booking the remnant (what the user paid minus VTpass cost) as pool gain is the
 * ledger step that calls this — enforced by the caller, not here.
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
  const enabled = Boolean(token && client);
  const disabledReason = !token
    ? "INTERNAL_API_TOKEN not set"
    : !client
      ? "VTPASS_API_KEY/VTPASS_SECRET_KEY not set"
      : "";

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
      const network = String(body.network ?? "");
      const phone = String(body.phone ?? "");
      const amount = body.amount != null ? Number(body.amount) : NaN;
      if (!network || !phone || !(amount > 0)) {
        return (
          void send(res, 400, {
            error: "network, phone and a positive amount are required",
          }),
          true
        );
      }
      const result = await client!.buyAirtime({ network, amount, phone });
      // 200 on delivered; 202 when accepted but not yet confirmed (pending).
      return void send(res, result.success ? 200 : 202, result), true;
    } catch (err) {
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
