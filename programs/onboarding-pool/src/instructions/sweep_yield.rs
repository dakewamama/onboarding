use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};

use crate::errors::PoolError;
use crate::events::YieldSwept;
use crate::state::Pool;

const SWEEP_MARGIN: u64 = 1_000;

#[derive(Accounts)]
pub struct SweepYield<'info> {
    pub authority: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        seeds = [b"pool", pool.seed.to_le_bytes().as_ref()],
        bump = pool.bump,
        has_one = authority,
        has_one = mint @ PoolError::InvalidMint,
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = pool,
    )]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub treasury: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

impl<'info> SweepYield<'info> {
    pub fn sweep_yield(&mut self) -> Result<()> {
        require!(
            self.treasury.key() == self.pool.treasury,
            PoolError::InvalidTreasury
        );

        let excess = self.vault.amount.saturating_sub(self.pool.total_principal);
        let sweepable = excess.saturating_sub(SWEEP_MARGIN);
        require!(sweepable > 0, PoolError::NothingToSweep);

        self.sweep_tokens(sweepable)?;

        emit!(YieldSwept {
            pool: self.pool.key(),
            treasury: self.treasury.key(),
            amount: sweepable,
            total_principal: self.pool.total_principal,
        });

        Ok(())
    }

    pub fn sweep_tokens(&self, amount: u64) -> Result<()> {
        let signer_seeds: &[&[&[u8]]] = &[&[
            b"pool",
            &self.pool.seed.to_le_bytes(),
            &[self.pool.bump],
        ]];

        let cpi_program = self.token_program.to_account_info();

        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.treasury.to_account_info(),
            authority: self.pool.to_account_info(),
        };

        let ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        transfer(ctx, amount)
    }
}
