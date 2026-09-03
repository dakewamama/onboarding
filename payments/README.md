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
2. Set service variables: `PAJ_API_KEY`, `PAJ_WEBHOOK_SECRET`, `PAJ_ENV=staging`,
   `PAJ_MODE`, `PAJ_MINT`, `PAJ_CURRENCY`. Railway injects `PORT` automatically.
3. Deploy, then grab the public domain. Your webhook URL is
   `https://<app>.up.railway.app/webhooks/paj`.
4. From anywhere with the API key, set `PAJ_WEBHOOK_URL` to that and run
   `yarn run paj-verify-receiver` — it PATCHes the URL and fires `test-webhook`;
   expect `delivered: true` (the receiver returns 200 to the signed sample).

Note: Railway's container filesystem is ephemeral, so the file-based store
(`orderReference<->pajId`, idempotency) resets on redeploy. For the webhook test
that's fine. For real settlement correlation, attach a Railway volume and point
`PAJ_STORE_DIR` at it, or swap the store for a database.

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
