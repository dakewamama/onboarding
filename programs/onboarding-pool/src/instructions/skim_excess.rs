use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};

use crate::errors::PoolError;
use crate::events::ExcessSkimmed;
use crate::state::Pool;

#[derive(Accounts)]
pub struct SkimExcess<'info> {
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

impl<'info> SkimExcess<'info> {
    pub fn skim_excess(&mut self) -> Result<()> {
        require!(!self.pool.paused, PoolError::Paused);
        require!(
            self.treasury.key() == self.pool.treasury,
            PoolError::InvalidTreasury
        );

        // Everything in the vault above `total_principal` is surplus that belongs
        // to the treasury. Solvency (invariant 1) guarantees the vault holds at
        // least `total_principal`, so this subtraction never underflows; a checked
        // sub turns any violation into an error instead of a silent wrap.
        let excess = self
            .vault
            .amount
            .checked_sub(self.pool.total_principal)
            .ok_or(PoolError::MathOverflow)?;
        require!(excess > 0, PoolError::NothingToSkim);

        self.skim_tokens(excess)?;

        emit!(ExcessSkimmed {
            pool: self.pool.key(),
            treasury: self.treasury.key(),
            amount: excess,
            total_principal: self.pool.total_principal,
        });

        Ok(())
    }

    pub fn skim_tokens(&self, amount: u64) -> Result<()> {
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"pool", &self.pool.seed.to_le_bytes(), &[self.pool.bump]]];

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
