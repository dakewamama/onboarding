import * as http from "http";
import { URL } from "url";
import { FundingService } from "./service";
import { loadFundingConfig } from "./config";
import { bearerAuthorized, readJson, send } from "../httpUtil";

/**
 * HTTP surface for crypto funding, mounted in server.ts. Every route needs the
 * INTERNAL_API_TOKEN bearer (server-to-server only). Without SOLANA_RPC_URL the
 * routes return 503.
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
  /** Arm the deposit watch for a wallet (null when funding isn't configured). */
  armWatch: ((owner: string) => void) | null;
}

export function mountFunding(env: NodeJS.ProcessEnv = process.env): FundingMount {
  let service: FundingService | null = null;
  let disabledReason = "";
  const token = env.INTERNAL_API_TOKEN;

  try {
    service = new FundingService(loadFundingConfig());
    service.start();
  } catch (err) {
    disabledReason = (err as Error).message;
  }

  const text = (body: Record<string, unknown>, key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (!url.pathname.startsWith("/funding/")) return false;
    // Balances and deposit history are per user: brain calls these server-to-server.
    if (!bearerAuthorized(req, token)) {
      send(res, token ? 401 : 503, { error: token ? "unauthorized" : "INTERNAL_API_TOKEN not set" });
      return true;
    }
    if (!service) {
      send(res, 503, { error: "crypto funding not configured", detail: disabledReason });
      return true;
    }

    try {
      if (req.method === "POST" && url.pathname === "/funding/address") {
        const owner = text(await readJson(req), "owner");
        if (!owner) { send(res, 400, { error: "owner is required" }); return true; }
        send(res, 200, service.issueDepositAddress(owner));
        return true;
      }

      if (req.method === "POST" && url.pathname === "/funding/build-transfer") {
        const body = await readJson(req);
        const fromWallet = text(body, "fromWallet"), owner = text(body, "owner"), amountUsdc = text(body, "amountUsdc");
        if (!fromWallet || !owner || !amountUsdc) { send(res, 400, { error: "fromWallet, owner and amountUsdc are required" }); return true; }
        send(res, 200, await service.buildTransfer(fromWallet, owner, amountUsdc));
        return true;
      }

      if (req.method === "GET" && url.pathname === "/funding/balance") {
        const owner = url.searchParams.get("owner");
        if (!owner) { send(res, 400, { error: "owner is required" }); return true; }
        send(res, 200, await service.balance(owner));
        return true;
      }

      if (req.method === "GET" && url.pathname === "/funding/deposits") {
        const owner = url.searchParams.get("owner");
        if (!owner) { send(res, 400, { error: "owner is required" }); return true; }
        send(res, 200, { owner, deposits: await service.deposits(owner) });
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

  return {
    handle,
    logStatus,
    armWatch: service ? (owner: string) => service!.armWatch(owner) : null,
  };
}
