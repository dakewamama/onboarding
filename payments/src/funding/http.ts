import * as http from "http";
import { URL } from "url";
import { FundingService } from "./service";
import { loadFundingConfig } from "./config";

/**
 * Framework-free HTTP surface for the crypto-funding flow, mounted alongside the
 * Paj webhook receiver in server.ts. If SOLANA_RPC_URL is not configured, this is
 * inert — the Paj receiver keeps working untouched, and /funding/* returns 503.
 *
 * Routes (step 1 — deposit-address display + credit-on-confirmation):
 *   POST /funding/address        { owner }                       -> address + QR, arms watch
 *   POST /funding/build-transfer { fromWallet, owner, amountUsdc } -> unsigned tx (base64)
 *   GET  /funding/balance        ?owner=                         -> durably-credited balance
 *   GET  /funding/deposits       ?owner=                         -> credited deposit history
 */
export interface FundingMount {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
  logStatus(port: number): void;
}

export function mountFunding(): FundingMount {
  let service: FundingService | null = null;
  let disabledReason = "";

  try {
    service = new FundingService(loadFundingConfig());
    service.start();
  } catch (err) {
    disabledReason = (err as Error).message;
  }

  // Resolve the CORS origin to echo for this request against the configured
  // allowlist. Returns null when the request origin isn't allowed (no header set).
  function allowedOrigin(reqOrigin: string | undefined): string | null {
    const allow = service ? service.config.corsOrigins : [];
    if (allow.length === 0) return null;
    if (allow.includes("*")) return "*";
    return reqOrigin && allow.includes(reqOrigin) ? reqOrigin : null;
  }

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/funding/")) return false;

    // CORS: the browser frontend (Vercel) calls this backend (Railway) cross-origin.
    const origin = allowedOrigin(
      Array.isArray(req.headers.origin) ? req.headers.origin[0] : req.headers.origin
    );
    if (origin) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "content-type");
      res.setHeader("Access-Control-Max-Age", "86400");
    }
    // Answer the preflight before any routing/auth.
    if (req.method === "OPTIONS") {
      res.writeHead(origin ? 204 : 403).end();
      return true;
    }

    if (!service) {
      send(res, 503, { error: "crypto funding not configured", detail: disabledReason });
      return true;
    }

    try {
      if (req.method === "POST" && url.pathname === "/funding/address") {
        const body = await readJson(req);
        const owner = String((body as any).owner ?? "");
        if (!owner) return void send(res, 400, { error: "owner is required" }), true;
        send(res, 200, service.issueDepositAddress(owner));
        return true;
      }

      if (req.method === "POST" && url.pathname === "/funding/build-transfer") {
        const body = (await readJson(req)) as any;
        const fromWallet = String(body.fromWallet ?? "");
        const owner = String(body.owner ?? "");
        const amountUsdc = String(body.amountUsdc ?? "");
        if (!fromWallet || !owner || !amountUsdc) {
          return void send(res, 400, {
            error: "fromWallet, owner and amountUsdc are required",
          }), true;
        }
        send(res, 200, await service.buildTransfer(fromWallet, owner, amountUsdc));
        return true;
      }

      if (req.method === "GET" && url.pathname === "/funding/balance") {
        const owner = url.searchParams.get("owner");
        if (!owner) return void send(res, 400, { error: "owner is required" }), true;
        send(res, 200, service.balance(owner));
        return true;
      }

      if (req.method === "GET" && url.pathname === "/funding/deposits") {
        const owner = url.searchParams.get("owner");
        if (!owner) return void send(res, 400, { error: "owner is required" }), true;
        send(res, 200, { owner, deposits: service.deposits(owner) });
        return true;
      }

      send(res, 404, { error: "unknown funding route" });
      return true;
    } catch (err) {
      console.error("[funding] request error", err);
      send(res, 400, { error: (err as Error).message });
      return true;
    }
  }

  function logStatus(port: number): void {
    if (service) {
      console.log(
        `Crypto funding on http://localhost:${port}/funding/* ` +
          `(mint=${service.config.usdcMint}, commitment=${service.config.commitment})`
      );
    } else {
      console.log(`Crypto funding disabled: ${disabledReason}`);
    }
  }

  return { handle, logStatus };
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readJson(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}
