# onboarding pool — client

Thin client for the deployed `onboarding-pool` program. The on-chain layout is
frozen: this client adds no instructions and requires no program change.

## What it does

- Users log in with a phone number via **Privy** embedded Solana wallets (no seed
  phrase, non-custodial). The user holds no SOL.
- **Fees are sponsored (D7).** The gas wallet is the `feePayer` and pays SOL. On
  top of each pool instruction the client composes a second instruction: a fixed
  USDC service fee transferred from the user to a collection wallet.
- The client only **signs**, never sends. It POSTs the user-signed transaction to
  the sponsor backend, which adds the gas signature and submits.

## Architecture

```
src/
  signer/      useSigner (Privy, the ONLY Privy import) + dev keypair fallback
  tx/          buildDeposit / buildWithdraw / submit + shared assembly + fee ix
  reads/       pool + position (with projected points)
  generated/   kit client generated from the IDL by Codama (do not edit)
  app/         minimal React UI
server/
  sponsor.ts   adds the gas signature and submits (holds the gas key)
scripts/
  generate-client.ts   regenerates src/generated from target/idl
```

Kit-only: `@solana/kit` + `@solana-program/token`, no `@solana/web3.js`. The
program client is generated from the IDL (Codama) so no account layouts are
hand-written.

## Setup

```bash
cd client
yarn install --ignore-engines
yarn gen          # regenerate src/generated after any `anchor build`
cp .env.example .env   # fill in values
```

Fill `.env`:

- `VITE_PRIVY_APP_ID` — from the Privy dashboard.
- `VITE_RPC_URL`, `VITE_PROGRAM_ID`, `VITE_USDC_MINT`, `VITE_POOL_SEED`.
- `VITE_GAS_WALLET`, `VITE_COLLECTION_WALLET` — **public keys only**.
- `VITE_FEE_AMOUNT` — service fee in USDC base units (6 decimals).

## Run

Backend (holds the gas key):

```bash
# GAS_WALLET_KEYPAIR points at a throwaway localnet keypair json — never a funded
# or mainnet key.
yarn sponsor
```

Frontend:

```bash
yarn dev
```

Privy requires **HTTPS** in production; dev is allowed on `http://localhost`
only.

### Dev without Privy

Set `VITE_DEV_SIGNER=1` and `VITE_DEV_KEYPAIR=[...64 bytes...]` (a throwaway
localnet key) to drive the whole flow with a local keypair instead of Privy.

## Keys and money — read this

- The client never generates, funds, or hardcodes a real key. The gas and
  collection wallets are config public keys the operator holds elsewhere.
- The gas keypair lives only on the sponsor backend, loaded from
  `GAS_WALLET_KEYPAIR`. Keep it off mainnet while testing.
- **Money-services note (§8):** every deposit/withdraw moves USDC from the user
  to an operator-controlled collection wallet. Collecting per-transaction fees
  from users resembles money-services activity and may carry licensing/compliance
  obligations depending on jurisdiction. Flagging, not advising.
- Refilling the gas wallet by swapping collected USDC→SOL (e.g. Jupiter) is a
  separate backend job, out of scope for this client.
```
