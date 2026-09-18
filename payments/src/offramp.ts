import * as http from "http";
import { URL } from "url";
import { timingSafeEqual } from "crypto";
import { PajClient } from "./pajClient";
import { PajConfig } from "./config";

/**
 * Authenticated off-ramp initiation, mounted next to the webhook receiver. This
 * is the ONLY place that talks to Paj outbound with the API key. The brain calls
 * it to move money; it is gated by INTERNAL_API_TOKEN so the public URL can't.
 *
 * Fail-closed: if the Paj key or the internal token isn't set, every route 503s.
 * Deterministic: the caller passes validated bank details + amount; no model in
 * the loop. Account-name confirmation happens ahead of time via /resolve-account.
 */
export interface OfframpMount {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
  logStatus(port: number): void;
}

export function mountOfframp(cfg: PajConfig): OfframpMount {
  const token = process.env.INTERNAL_API_TOKEN;
  const client = cfg.apiKey ? new PajClient({ apiKey: cfg.apiKey, env: cfg.env }) : null;
  const enabled = Boolean(token && client);
  const disabledReason = !token
    ? "INTERNAL_API_TOKEN not set"
    : !client
      ? "PAJ_API_KEY not set"
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
    if (!url.pathname.startsWith("/offramp")) return false;

    if (!enabled) return void send(res, 503, { error: disabledReason }), true;
    if (!authorized(req)) return void send(res, 401, { error: "unauthorized" }), true;
    if (req.method !== "POST") return void send(res, 405, { error: "method" }), true;

    try {
      const body = await readJson(req);
      if (url.pathname === "/offramp/resolve-account") {
        const accountNumber = String(body.accountNumber ?? "");
        if (!accountNumber) return void send(res, 400, { error: "accountNumber required" }), true;
        const result = await client!.resolveBankAccount({ accountNumber });
        return void send(res, 200, result), true;
      }
      if (url.pathname === "/offramp/register") {
        // The correct v2 primitive: register (idempotent) and return the
        // PERMANENT deterministic address + bank-verified accountName. The caller
        // confirms the name with the user, caches the address, then funds it.
        const bankCode = String(body.bankCode ?? "");
        const accountNumber = String(body.accountNumber ?? "");
        if (!bankCode || !accountNumber) {
          return void send(res, 400, { error: "bankCode and accountNumber required" }), true;
        }
        const account = await client!.registerBankAccount({ bankCode, accountNumber });
        return void send(res, 200, account), true;
      }
      if (url.pathname === "/offramp") {
        const bankCode = String(body.bankCode ?? "");
        const accountNumber = String(body.accountNumber ?? "");
        const fiatAmount = body.fiatAmount != null ? Number(body.fiatAmount) : undefined;
        const amount = body.amountUsdc != null ? Number(body.amountUsdc) : undefined;
        if (!bankCode || !accountNumber || (!fiatAmount && !amount)) {
          return void send(res, 400, {
            error: "bankCode, accountNumber and fiatAmount|amountUsdc required",
          }), true;
        }
        const order = await client!.createOfframp({
          accountNumber,
          bankCode,
          currency: cfg.currency,
          mint: cfg.mint,
          chain: cfg.chain,
          fiatAmount,
          amount,
          webhookURL: cfg.webhookUrl,
          saveBeneficiary: true,
          description: typeof body.description === "string" ? body.description : undefined,
        });
        return void send(res, 200, order), true;
      }
      return void send(res, 404, { error: "not found" }), true;
    } catch (err) {
      // Never leak the key; surface a generic error.
      console.error("[offramp] error", (err as Error).message);
      return void send(res, 502, { error: "off-ramp failed" }), true;
    }
  }

  function logStatus(_port: number): void {
    console.log(
      enabled
        ? "[offramp] authenticated off-ramp routes enabled (/offramp/register, /offramp, /offramp/resolve-account)"
        : `[offramp] disabled (${disabledReason})`,
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
