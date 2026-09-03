# Custodial signing service (devnet prototype)

Axis holds each user's key and signs `deposit` / `withdraw` on their behalf, after
the user has authorized it. This is a **custodial** model: the user grants Axis
permission to pay and transfer for them, and Axis produces the on-chain signature.

> **Regulatory note.** Holding user keys and moving user funds is custody and very
> likely money transmission. This prototype does not make that legal — it is the
> engineering side of a decision that also needs the appropriate license/registration
> and counsel. Treat this as an architecture reference, not a compliance artifact.

## What it demonstrates

- **Custodial keystore** (`keystore.ts`) — per-user keypairs, encrypted at rest with
  envelope encryption (AES-256-GCM under a master key). Keys are decrypted only for
  the duration of a signing call, then zeroed.
- **Authorization** (`authorizations.ts`) — an explicit, recorded consent (scope +
  per-tx cap). No signature is produced without it.
- **Audit trail** (`audit.ts`) — append-only log of every key creation, consent, and
  signature.
- **Signing service** (`service.ts`) — builds, signs, and submits deposit/withdraw
  against the deployed program. The operator wallet is fee payer / gas; the custodial
  key is the `user` signer.
- **HTTP wrapper** (`http.ts`) and an end-to-end **devnet demo** (`demo.ts`).

The on-chain program is **unchanged**. It only checks that a valid `user` signature
is present; custody is entirely about who holds and controls that key off-chain.

## The one hard line

This is a **devnet prototype with throwaway keys**. Never point it at mainnet keys
or real funds. In production:

| Prototype (here)                     | Production                                  |
| ------------------------------------ | ------------------------------------------- |
| local `master.key` file              | non-exportable CMK in a KMS/HSM             |
| key decrypted in process to sign     | signing happens inside the KMS/HSM boundary |
| `.keystore/` JSON files              | HSM-backed store, no plaintext keys at rest |
| `.audit/audit.log` file              | tamper-evident / WORM audit store           |
| JSON consent file                    | signed consent tied to authenticated + KYC'd identity |
| open HTTP, no auth                   | authn/z, TLS, rate limits, per-route policy |

`.keystore/` and `.audit/` are gitignored and must never be committed.

## Run

```bash
solana airdrop 2   # operator needs a little devnet SOL

# full flow: create user -> fund -> block w/o consent -> authorize -> deposit -> withdraw
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
ANCHOR_WALLET=~/.config/solana/id.json \
yarn run custody-demo

# or run the HTTP service
ANCHOR_PROVIDER_URL=https://api.devnet.solana.com yarn run custody-server
```

### HTTP routes

| Method | Path                         | Body                                  |
| ------ | ---------------------------- | ------------------------------------- |
| POST   | `/users`                     | `{ userId }`                          |
| POST   | `/users/:id/authorize`       | `{ scope: ["deposit","withdraw"], maxAmountPerTx? }` |
| POST   | `/users/:id/deposit`         | `{ mint, pool, amount }`              |
| POST   | `/users/:id/withdraw`        | `{ mint, pool, amount }`              |
| GET    | `/users/:id/position?pool=`  | —                                     |
