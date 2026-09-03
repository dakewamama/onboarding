# onboarding-pool

A **protocol-revenue deposit vault** with sponsored onboarding and a time-weighted
points ledger, built with Anchor on Solana.

Program ID: `FQ95QLushdus3WQv193HyedsVg3TGHqhw7dLpJtY5sgV`
Anchor 0.32.1 · Solana 2.3.0 · Rust 1.89.0

## What this is

- Deposits are held **1:1**. `position.principal` and `pool.total_principal` are
  raw token amounts, not shares. There is no share price and no redemption curve.
- **Surplus in the vault belongs to the protocol treasury, not to depositors.**
  If the vault ever holds more than `total_principal`, that difference is protocol
  revenue and can be skimmed to the treasury. Depositors are entitled to their
  principal and nothing more.
- There is **no yield strategy**. The vault never lends, stakes, or CPIs anywhere.
  Any surplus arrives as a direct token transfer into the vault ATA by someone
  (e.g. the protocol operator). The program does not produce yield; it holds
  deposits and lets the treasury collect whatever surplus is placed there.
- A depositor's return is **points**: `principal × seconds held`, accumulated on
  the Position. There is no claim instruction and no reward mint yet — points are
  informational only. This is a known, documented gap, not a bug.
- Deposits support a **relayer**: the `payer` signer can differ from the `user`
  signer, so a wallet holding zero SOL can still deposit (someone else pays the
  fees and the Position rent).

## Invariants

These hold after every instruction. Tests assert them; they are not weakened to
make a test pass.

1. **Solvency:** `vault.amount >= pool.total_principal`.
2. **Principal conservation:** `pool.total_principal` equals the sum of all
   `position.principal`. It changes only by the exact amount passed to `deposit`
   or `withdraw`.
3. **Withdrawal liveness:** a user with `principal >= amount` can always withdraw,
   regardless of pool state. No admin action can prevent this.
4. **Points monotonicity:** a position's points never decrease.

## PDAs

| Account   | Seeds                              | Notes                          |
| --------- | ---------------------------------- | ------------------------------ |
| Pool      | `["pool", seed as u64 LE]`         | `seed` is chosen by the caller |
| Position  | `["position", pool, user]`         | one per (pool, user)           |
| Vault     | `ATA(mint, authority = pool)`      | associated token account       |

```
                 ┌──────────────┐
                 │   Pool PDA   │──── authority ──▶ vault ATA (holds all deposits)
                 └──────┬───────┘
                        │ one per (pool, user)
              ┌─────────┴─────────┐
        ┌─────▼─────┐       ┌─────▼─────┐
        │ Position  │  ...  │ Position  │   principal + points per depositor
        └───────────┘       └───────────┘
```

## Sponsored deposits

`deposit` takes **two** signers:

- `user` — owns the Position and authorizes the token transfer out of their token
  account.
- `payer` — pays the transaction fee and the rent for the Position PDA on first
  deposit.

Because they are separate, a relayer can set `payer` to its own hot wallet while
the user signs only for their funds. A user with no SOL can therefore onboard: the
relayer builds the transaction, sets itself as `payer` and fee payer, collects the
user's signature, and submits. `withdraw` needs no such split — the user's own
account already exists — so it takes only the `user` signer.

The user's token account may be any account of the pool mint owned by the user; it
need not be the associated token account.

## Pool creation is permissionless

`initialize_pool` takes a caller-chosen `seed` and is open to anyone. There is no
gatekeeping: any account can create a pool on this program, becoming its authority
and choosing its mint and treasury. Pools are isolated by their seed-derived PDA.

## What this deliberately does not do (yet)

- **No yield source.** The program produces no return on deposits. Surplus is
  whatever someone transfers in, and it belongs to the treasury.
- **No points claim.** Points accumulate but cannot be redeemed; there is no
  reward mint or claim instruction.
- **Legacy SPL Token only.** No Token-2022, no transfer-fee mints. The legacy-token
  pin is what currently keeps the solvency invariant safe.
- **Single-asset pools.** One mint per pool; no multi-asset or basket pools.

## Development

```bash
anchor build
anchor test
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

## License

MIT — see [LICENSE](LICENSE).
