import * as http from "http";
import {
  CustodyTransferConflict,
  CustodyTransferNotFound,
  custodyTransferFromEnv,
  type CustodyTransferInput,
  type CustodyTransferService,
} from "./custodyTransfer";
import { squadsControlStatus } from "./squads";
import { InsufficientBalanceError } from "./funding/spendLedger";
import { bearerAuthorized, readJson, send } from "./httpUtil";

export interface CustodyTransferMount {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
  logStatus(port: number): void;
}

/** Pending and in-doubt transfers answer 202: the outcome is not final yet. */
const statusCode = (status: string) => (status === "pending" || status === "in_doubt" ? 202 : 200);

/**
 * Brain's custody transfer routes (INTERNAL_API_TOKEN bearer):
 *   POST /wallet/transfer                     move USDC from a user's custodial wallet
 *   GET  /wallet/transfer/status?idempotencyKey=
 *   GET  /wallet/holdings?userId=              on-chain USDC and SOL, and whether SOL can fund payouts
 *   GET  /treasury/status                      treasury control configuration
 */
export function mountCustodyTransfer(env: NodeJS.ProcessEnv = process.env): CustodyTransferMount {
  const token = env.INTERNAL_API_TOKEN;
  const enabled = env.AXIS_CUSTODY_TRANSFER_ENABLED === "true";
  let service: CustodyTransferService | null = null;
  let initError = "";
  if (enabled) {
    try {
      service = custodyTransferFromEnv(env);
    } catch (error) {
      initError = (error as Error).message;
    }
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const transfer = url.pathname === "/wallet/transfer" || url.pathname === "/wallet/transfer/status" || url.pathname === "/wallet/holdings";
    const treasury = url.pathname === "/treasury/status";
    if (!transfer && !treasury) return false;
    if (!token) { send(res, 503, { error: "INTERNAL_API_TOKEN not set" }); return true; }
    if (!bearerAuthorized(req, token)) { send(res, 401, { error: "unauthorized" }); return true; }

    if (treasury) {
      if (req.method !== "GET") { send(res, 405, { error: "method" }); return true; }
      try {
        send(res, 200, squadsControlStatus(env));
      } catch (error) {
        send(res, 503, { error: (error as Error).message });
      }
      return true;
    }

    if (!service) { send(res, 503, { error: initError || "AXIS_CUSTODY_TRANSFER_ENABLED is not true" }); return true; }

    try {
      if (url.pathname === "/wallet/holdings") {
        if (req.method !== "GET") { send(res, 405, { error: "method" }); return true; }
        const userId = url.searchParams.get("userId");
        if (!userId) { send(res, 400, { error: "userId required" }); return true; }
        send(res, 200, await service.holdings(userId));
        return true;
      }

      if (url.pathname === "/wallet/transfer/status") {
        if (req.method !== "GET") { send(res, 405, { error: "method" }); return true; }
        const key = url.searchParams.get("idempotencyKey");
        if (!key) { send(res, 400, { error: "idempotencyKey required" }); return true; }
        const result = await service.status(key);
        send(res, statusCode(result.status), result);
        return true;
      }

      if (req.method !== "POST") { send(res, 405, { error: "method" }); return true; }
      let raw: Record<string, unknown>;
      try {
        raw = await readJson(req);
      } catch (error) {
        send(res, 400, { error: (error as Error).message });
        return true;
      }
      const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : "");
      const input: CustodyTransferInput = {
        owner: text("owner"),
        asset: text("asset") as CustodyTransferInput["asset"],
        network: text("network") as "SOLANA",
        destination: text("destination"),
        amountMinor: text("amountMinor"),
        maxDebitMinor: text("maxDebitMinor"),
        idempotencyKey: text("idempotencyKey"),
      };
      const result = await service.transfer(input);
      send(res, statusCode(result.status), result);
      return true;
    } catch (error) {
      if (error instanceof CustodyTransferConflict) { send(res, 409, { error: error.message }); return true; }
      if (error instanceof CustodyTransferNotFound) { send(res, 404, { error: error.message }); return true; }
      if (error instanceof InsufficientBalanceError) {
        send(res, 402, { error: "insufficient balance", status: "failed", moneyState: "RELEASED", reason: "insufficient_balance" });
        return true;
      }
      // Anything else is not a verdict on the money: the caller must treat it as unknown.
      console.error("[custody] transfer error", error);
      send(res, 500, { error: (error as Error).message });
      return true;
    }
  }

  function logStatus(port: number): void {
    const transfer = !enabled ? "disabled" : service ? "ready" : `unavailable: ${initError}`;
    let squads = "disabled";
    try {
      squads = squadsControlStatus(env).configured ? "configured" : "disabled";
    } catch (error) {
      squads = `invalid: ${(error as Error).message}`;
    }
    console.log(`[custody] /wallet/transfer on :${port} ${transfer}; squads ${squads}`);
  }

  return { handle, logStatus };
}
