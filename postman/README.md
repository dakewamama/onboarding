# Axis live production tests (Postman)

Import `axis.postman_collection.json` into Postman, then set the collection
variables (Collection → Variables). Secrets are variables, never committed.

## Variables to fill
- `BRAIN_URL`, `ONBOARDING_URL`, `CUSTODY_URL` — the Railway service hosts.
- `INTERNAL_API_TOKEN` — brain↔onboarding shared token (onboarding money rails).
- `ADMIN_TOKEN` — brain `/admin/*`.
- `CUSTODY_API_TOKEN` — custody server routes.
- `WEB_WEBHOOK_TOKEN` — only if enforced on brain `/webhooks/web`.
- `userId`, `walletAddress`, `phone`, `amount`, `network`, `bankCode`, `accountNumber`.

## Airtime live-test sequence (real money)
1. **Custody → create user**: returns the user's custodial wallet pubkey. Put it in `walletAddress`.
2. **Onboarding → airtime: link user → wallet** (`/airtime/link`): maps `userId` ↔ `walletAddress` so the debit reconciles.
3. **Fund the wallet**: send USDC to `walletAddress` on Solana mainnet (real), or use **funding: deposit address** for a QR. The watcher credits it (needs a working `SOLANA_RPC_URL`).
4. **Onboarding → airtime: buy**: charges the balance, delivers via VTpass, books remnant→pool. Or drive it conversationally via **Brain → chat turn**.

## Preconditions for a green live run
- onboarding env: `VTPASS_API_KEY/SECRET/PUBLIC`, `VTPASS_ENV`, `AXIS_USDC_NGN_RATE`, `INTERNAL_API_TOKEN`, `CUSTODY_API_TOKEN`, a real `SOLANA_RPC_URL` (not the public one).
- brain env: `ONBOARDING_URL`, `INTERNAL_API_TOKEN`, model keys, `ADMIN_TOKEN`.
- A funded USDC balance for the user.

## Diagnostics (no money moved)
- `Brain → health`, `admin: model-check`, `admin: browse-check`.
- `Onboarding → funding: balance` — confirms the credited balance before a buy.
- `offramp: resolve account name` — confirms a bank account name before any transfer.
