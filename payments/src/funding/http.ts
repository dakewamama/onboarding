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
 *   POST /funding/address     { owner }            -> deposit address + QR, arms the watch
 *   GET  /funding/balance     ?owner=              -> durably-credited USDC balance
 *   GET  /funding/deposits    ?owner=              -> credited deposit history
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

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/funding/")) return false;

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
