/**
 * Minimal webhook receiver (devnet/staging prototype). Reads the RAW body (never
 * pre-parsed, so the signature verifies), runs the handler, and returns the
 * status Paj expects. In production this sits behind TLS + a real framework.
 *
 *   PAJ_API_KEY=... PAJ_WEBHOOK_SECRET=whsec_... PAJ_ENV=staging \
 *   yarn run paj-webhook-server
 */
import * as http from "http";
import { loadConfig } from "./config";
import { PajProvider } from "./pajProvider";
import { handleWebhook } from "./webhookHandler";
import { Settlement } from "./types";

const cfg = loadConfig();
if (!cfg.webhookSecret) {
  console.warn(
    "[warn] PAJ_WEBHOOK_SECRET not set — every webhook will be rejected (400) until it is. " +
      "Register the URL via PATCH /pub/v2/webhook, then set the returned whsec_ value here."
  );
}
const provider = new PajProvider(cfg);
const PORT = Number(process.env.PORT ?? 8788);

// Replace this with your real crediting logic (e.g. release funds to the user).
async function credit(s: Settlement): Promise<void> {
  console.log(
    `[credit] order=${s.reference ?? "?"} pajId=${s.pajId} usdc=${s.amountUsdc} status=${s.status}`
  );
}

const server = http.createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/webhooks/paj") {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const rawBody = Buffer.concat(chunks).toString("utf8");
    try {
      const result = await handleWebhook(provider, rawBody, req.headers, credit);
      console.log(`[webhook] ${result.status} ${result.note}`);
      res.writeHead(result.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ note: result.note }));
    } catch (err) {
      console.error("[webhook] error", err);
      res.writeHead(500).end();
    }
  });
});

server.listen(PORT, () => {
  console.log(
    `Paj webhook receiver on http://localhost:${PORT}/webhooks/paj (env=${cfg.env}, mode=${cfg.mode})`
  );
});
