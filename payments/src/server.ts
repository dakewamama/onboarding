/**
 * The payments service: custodial wallets, airtime, custody transfers, deposit
 * watching and the PAJ webhook receiver. Axis Money (the ledger) must be
 * configured before anything else starts.
 */
import * as http from "http";
import { loadConfig } from "./config";
import { PajProvider } from "./pajProvider";
import { handleWebhook } from "./webhookHandler";
import { Settlement } from "./types";
import { mountFunding } from "./funding/http";
import { mountOfframp } from "./offramp";
import { mountAirtime } from "./airtime";
import { mountCustodyTransfer } from "./custodyTransferHttp";
import { openMoneyLedger, PostgresMoneyLedger } from "./funding/moneyLedger";
import { fundingStoreDir } from "./funding/config";

// Axis Money is configured before anything else. A missing production ledger
// is fatal and must exit non-zero so the platform reports a failed deploy.
let money: ReturnType<typeof openMoneyLedger>;
try {
  money = openMoneyLedger(process.env, fundingStoreDir(process.env));
} catch (error) {
  console.error("[money] ledger misconfigured; refusing to start:", (error as Error).message);
  process.exit(1);
}

// A stray rejection (e.g. an RPC blip in a watcher poll) is logged and survived.
// An uncaught exception leaves the process in an unknown state: exit and let the
// platform restart it, rather than keep moving money from a corrupted process.
process.on("unhandledRejection", (reason) => {
  console.error("[error] unhandledRejection:", reason);
});
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException; exiting:", err);
  process.exit(1);
});

const cfg = loadConfig();
if (!cfg.webhookSecret) {
  console.warn(
    "[warn] PAJ_WEBHOOK_SECRET not set — every webhook will be rejected (400) until it is. " +
      "Register the URL via PATCH /pub/v2/webhook, then set the returned whsec_ value here."
  );
}
const provider = new PajProvider(cfg);
const PORT = Number(process.env.PORT ?? 8788);

// PAJ settlements are recorded, not credited: nothing in this service holds a
// balance for PAJ orders (brain reconciles its own payouts). Log for audit.
async function recordSettlement(s: Settlement): Promise<void> {
  console.log(
    `[paj] settled order=${s.reference ?? "?"} pajId=${s.pajId} usdc=${s.amountUsdc} status=${s.status}`
  );
}

// Additive crypto-funding routes (USDC on Solana). Started only when configured
// (SOLANA_RPC_URL set); the Paj receiver runs unchanged either way. Returns a
// handler that claims /funding/* requests and reports whether it handled one.
const funding = mountFunding();
// Authenticated off-ramp initiation for the brain (needs PAJ_API_KEY +
// INTERNAL_API_TOKEN). Fail-closed otherwise.
const offramp = mountOfframp(cfg);
// Authenticated airtime fulfilment for the brain (needs VTPASS_* +
// INTERNAL_API_TOKEN). Shares funding's watch-armer so creating a user's wallet
// also starts crediting its deposits.
const airtime = mountAirtime(process.env, funding.armWatch);
const custodyTransfer = mountCustodyTransfer(process.env);

async function handlePajWebhook(req: http.IncomingMessage, res: http.ServerResponse) {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c as Buffer));
  req.on("end", async () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    try {
      const result = await handleWebhook(provider, rawBody, req.headers, recordSettlement);
      console.log(`[webhook] ${result.status} ${result.note}`);
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ note: result.note }));
    } catch (err) {
      console.error("[webhook] error", err);
      res.writeHead(500).end();
    }
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, env: cfg.env, mode: cfg.mode }));
    return;
  }
  if (req.method === "POST" && req.url === "/webhooks/paj") {
    return handlePajWebhook(req, res);
  }
  if (await custodyTransfer.handle(req, res)) return;
  if (await offramp.handle(req, res)) return; // /offramp* claimed it
  if (await airtime.handle(req, res)) return;
  if (await funding.handle(req, res)) return; // /funding/* claimed it
  res.writeHead(404).end();
});

const moneyReady = money instanceof PostgresMoneyLedger ? money.migrate() : Promise.resolve();
moneyReady.then(() => server.listen(PORT, () => {
  console.log(
    `Paj webhook receiver on http://localhost:${PORT}/webhooks/paj (env=${cfg.env}, mode=${cfg.mode})`
  );
  funding.logStatus(PORT);
  custodyTransfer.logStatus(PORT);
  offramp.logStatus(PORT);
  airtime.logStatus(PORT);
  console.log(`[money] ledger ${money instanceof PostgresMoneyLedger ? "postgres" : "file (development only)"}`);
}), error => {
  console.error("[money] ledger unavailable; refusing to start", error);
  process.exit(1);
});

// Graceful shutdown: Railway sends SIGTERM to the old container on every redeploy.
// Close the server and exit 0 so it's a clean stop, not a "Deployment crashed"
// false alarm. Force-exit if something (e.g. the deposit watcher interval) hangs.
function shutdown(signal: string): void {
  console.log(`[server] ${signal} received; shutting down cleanly`);
  server.close(() => void money.close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
