use anchor_lang::prelude::*;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};

use crate::errors::PoolError;
use crate::events::Withdrawn;
use crate::state::{accrue, Pool, Position};

#[derive(Accounts)]
pub struct Withdraw<'info> {
    pub user: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"pool", pool.seed.to_le_bytes().as_ref()],
        bump = pool.bump,
        has_one = mint @ PoolError::InvalidMint,
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        mut,
        seeds = [b"position", pool.key().as_ref(), user.key().as_ref()],
        bump = position.bump,
    )]
    pub position: Account<'info, Position>,
    #[account(
        mut,
        token::mint = mint,
        token::authority = user,
    )]
    pub user_ata: Account<'info, TokenAccount>,
    #[account(
        mut,
        associated_token::mint = mint,
        associated_token::authority = pool,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

impl<'info> Withdraw<'info> {
    pub fn withdraw(&mut self, amount: u64) -> Result<()> {
        // Invariant 3 (withdrawal liveness): withdraw never checks `paused`.
        // A user with sufficient principal can always exit, regardless of pool state.
        require!(amount > 0, PoolError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;
        accrue(&mut self.position, now)?;

        require!(
            self.position.principal >= amount,
            PoolError::InsufficientPrincipal
        );

        // Points are never reset on withdraw: they are monotonic (invariant 4)
        // and informational. Reducing principal simply slows future accrual.
        self.withdraw_tokens(amount)?;

        self.position.principal = self
            .position
            .principal
            .checked_sub(amount)
            .ok_or(PoolError::MathOverflow)?;
        self.pool.total_principal = self
            .pool
            .total_principal
            .checked_sub(amount)
            .ok_or(PoolError::MathOverflow)?;

        emit!(Withdrawn {
            pool: self.pool.key(),
            user: self.user.key(),
            amount,
            total_principal: self.pool.total_principal,
        });

        Ok(())
    }

    pub fn withdraw_tokens(&self, amount: u64) -> Result<()> {
        let signer_seeds: &[&[&[u8]]] =
            &[&[b"pool", &self.pool.seed.to_le_bytes(), &[self.pool.bump]]];

        let cpi_program = self.token_program.to_account_info();

        let cpi_accounts = Transfer {
            from: self.vault.to_account_info(),
            to: self.user_ata.to_account_info(),
            authority: self.pool.to_account_info(),
        };

        let ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer_seeds);

        transfer(ctx, amount)
    }
}
