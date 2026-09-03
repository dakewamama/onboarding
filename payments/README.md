# Paj payment module (v2)

Off-chain TypeScript layer for off-ramping USDC to naira via Paj, and for receiving
Paj's settlement webhooks. This is **not** part of the Anchor program.

Built and verified against the live v2 docs (`docs.paj.cash`, openapi.json pulled
2026-09). Auth is **API-key only** (`x-api-key`); v2 dropped v1's emailed-OTP
session flow, so this runs unattended on a server.

## Settlement model (how you learn a payment succeeded)

You do **not** poll. There is no status-GET endpoint in v2. Instead:

1. Register your receiver once with `PATCH /pub/v2/webhook`
   (`rampWebhookURL` for off-ramp, `paymentWebhookURL` for payments).
2. Make a payment (`createPayment`), which returns a per-order deposit `address` +
   Paj's `id`. Fund that address with USDC.
3. When it settles, **Paj POSTs your webhook** with the final status. That signed
   POST is the only trigger for crediting.

Trust chain on the inbound webhook:
- Verify `X-PAJ-Signature` = HMAC-SHA256(`{X-PAJ-Timestamp}.{raw body}`, `whsec_...`),
  raw-bytes-first, timing-safe, reject if older than 300s.
- Idempotent on Paj's `id` (duplicate webhooks credit once).
- Credits only orders we created (`reference` resolves). A signed webhook for an
  unknown id — Paj's test-webhook sample, which is signed with the same secret — is
  acknowledged with 200 but never credited.
- `confirmSettled(pajId)` reflects "a signature-verified SUCCESSFUL webhook was
  recorded." Since v2 has no status-GET, that verified signature *is* Paj's
  confirmation.

## Interface

```ts
createPayment({ orderReference, amountUsdc, recipient, webhookUrl }) -> { pajId, depositAddress }
verifyWebhook(rawBody, signatureHeader, timestampHeader) -> boolean
confirmSettled(pajId) -> Promise<boolean>
parseSettlement(rawBody) -> { pajId, reference, amountUsdc, success, terminal, status }
```

`PAJ_MODE` selects the endpoint:
- `OFFRAMP` -> `POST /pub/v2/offramp` (crypto -> naira bank payout). `recipient` is
  `{ bankCode, accountNumber, currency? }`. Settles on `rampWebhookURL`.
- `PAYMENT` -> `POST /pub/v2/payment` method=TOKEN (collect USDC, no payout).
  Settles on `paymentWebhookURL`.

## Config (env, never commit)

See `.env.example`. `PAJ_API_KEY`, `PAJ_WEBHOOK_SECRET`, `PAJ_ENV`, `PAJ_MODE`,
`PAJ_CHAIN`, `PAJ_MINT`, `PAJ_CURRENCY`, `PAJ_WEBHOOK_URL`.

## Scripts

```bash
yarn run paj-selfcheck        # offline logic tests, no creds/network
yarn run paj-webhook-server   # receiver on :8788 /webhooks/paj (verifies signatures)
yarn run paj-verify-receiver  # PATCH your webhook URL + POST test-webhook to confirm delivery
```

## Deploy the receiver (Railway)

The receiver needs a public HTTPS URL so Paj can POST to it. `railway.json` +
`payments/Dockerfile` build **only** the receiver (no Anchor/Solana toolchain).

1. New Railway project from this GitHub repo (branch with these files). It picks up
   `railway.json` and builds `payments/Dockerfile`.
2. The receiver needs only `PAJ_WEBHOOK_SECRET` (to verify signatures). It makes NO
   outbound calls, so DO NOT put the API key on the Railway box. Optionally set
   `PAJ_MODE`. Railway injects `PORT`.
3. Because the secret comes from registering the webhook, and registering needs the
   URL, do it in this order:
   a. Create the Railway service and generate the public domain (available before a
      healthy boot). Webhook URL = `https://<app>.up.railway.app/webhooks/paj`.
   b. From your own terminal (not the receiver host), register it and read back the
      secret — this needs the API key, which stays on your machine:
      ```bash
      curl -X PATCH https://api.paj.cash/pub/v2/webhook \
        -H 'content-type: application/json' -H 'x-api-key: <API KEY>' \
        -d '{"rampWebhookURL":"https://<app>.up.railway.app/webhooks/paj"}'
      ```
      The response includes `webhookSecret` (`whsec_...`).
   c. Put that `whsec_...` into Railway as `PAJ_WEBHOOK_SECRET`, then redeploy.
4. Fire the test (also needs the API key, run from your terminal):
   ```bash
   curl -X POST 'https://api.paj.cash/pub/v2/webhook/test?type=RAMP' \
     -H 'x-api-key: <API KEY>'
   ```
   Expect `delivered: true`. The Railway logs should show
   `[webhook] 200 acknowledged; unknown pajId ... not credited`.
   (`yarn run paj-verify-receiver` does steps 3b + 4 in one go if you prefer.)

Note: Railway's container filesystem is ephemeral, so the file-based store
(`orderReference<->pajId`, idempotency) resets on redeploy. For the webhook test
that's fine. For real settlement correlation, attach a Railway volume and point
`PAJ_STORE_DIR` at it, or swap the store for a database.

## Crypto funding (USDC on Solana) + persistent volume

The same service also serves the additive USDC-funding routes (`/funding/*`) when
`SOLANA_RPC_URL` is set (otherwise inert; Paj runs unchanged). Env: `SOLANA_RPC_URL`,
`SOLANA_USDC_MINT`, `SOLANA_COMMITMENT`, `FUNDING_CORS_ORIGINS` (the browser
frontend's origin).

The funding **deposit ledger is money** — it's what makes crediting idempotent on
the tx signature and remembers deposits across restarts. It must survive redeploys,
not just process restarts. The image defaults `FUNDING_STORE_DIR=/data` and marks
`/data` a `VOLUME`, so:

1. In the Railway service, add a **Volume** with mount path **`/data`**.
2. Leave `FUNDING_STORE_DIR` unset (image default `/data`), or set it to your mount
   path if different.

Without a mounted volume, `/data` is still just ephemeral container disk and a
redeploy can lose or re-credit real deposits. Attach the volume before mainnet, or
swap the file store for a DB (the atomic `wx`-per-signature contract maps directly
to a `UNIQUE` constraint on the signature).

## Gotchas baked in (from v1 experience, verified against v2)

- Staging and production keys are provisioned separately (a prod key 404s/400s on
  staging). Test with staging-specific credentials.
- On staging the mainnet USDC mint 404s; set `PAJ_MINT` to the staging test mint.
- Amounts are decimals on the wire (`33.11`), not base units. We convert at the
  boundary and keep integer base units internally (no float math).
- No metadata/reference field on Paj's side; we map `orderReference <-> pajId`
  locally at creation time.
- Status vocab differs across surfaces; we normalise and match defensively
  (`SUCCESSFUL`/`COMPLETED` = success), never a strict enum switch.

## Still open (ask support@paj.cash)

Fee schedule, rate limits, and whether a private status-fetch endpoint exists.
