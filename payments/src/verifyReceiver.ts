/**
 * Prove your webhook receiver works BEFORE moving real money. Registers the
 * account-level webhook URLs, then asks Paj to POST a sample payload via the
 * test-webhook endpoint and reports whether it was delivered.
 *
 *   PAJ_API_KEY=... PAJ_ENV=staging PAJ_WEBHOOK_URL=https://your-host/webhooks/paj \
 *   yarn run paj-verify-receiver
 *
 * Requires staging-specific credentials (a production key returns
 * 400 "Can't find business" on staging).
 */
import { loadConfig } from "./config";
import { PajClient } from "./pajClient";

async function main() {
  const cfg = loadConfig();
  if (!cfg.webhookUrl) throw new Error("set PAJ_WEBHOOK_URL to your receiver URL");

  const client = new PajClient(cfg);
  const channel = cfg.mode === "OFFRAMP" ? "RAMP" : "PAYMENT";

  console.log(`env=${cfg.env} mode=${cfg.mode} channel=${channel}`);
  console.log(`registering webhook -> ${cfg.webhookUrl}`);

  await client.updateWebhooks(
    channel === "RAMP"
      ? { rampWebhookURL: cfg.webhookUrl }
      : { paymentWebhookURL: cfg.webhookUrl }
  );

  const result = await client.testWebhook(channel);
  console.log("test-webhook result:", JSON.stringify(result, null, 2));
  if (!result.delivered) {
    throw new Error(`receiver did not accept the test payload: ${result.error ?? "unknown"}`);
  }
  console.log("receiver verified.");
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err.message ?? err);
    process.exit(1);
  }
);
