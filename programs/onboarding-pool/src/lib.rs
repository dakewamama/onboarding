use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod instructions;
pub mod state;

use instructions::*;

declare_id!("FQ95QLushdus3WQv193HyedsVg3TGHqhw7dLpJtY5sgV");

#[program]
pub mod onboarding_pool {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>, seed: u64) -> Result<()> {
        ctx.accounts.initialize_pool(seed, ctx.bumps)
    }

    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        ctx.accounts.deposit(amount, ctx.bumps)
    }

    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        ctx.accounts.withdraw(amount)
    }

    pub fn sweep_yield(ctx: Context<SweepYield>) -> Result<()> {
        ctx.accounts.sweep_yield()
    }
}
