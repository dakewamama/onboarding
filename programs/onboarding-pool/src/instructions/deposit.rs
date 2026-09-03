use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{transfer, Mint, Token, TokenAccount, Transfer};

use crate::errors::PoolError;
use crate::events::Deposited;
use crate::state::{accrue, Pool, Position};

#[derive(Accounts)]
pub struct Deposit<'info> {
    pub user: Signer<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"pool", pool.seed.to_le_bytes().as_ref()],
        bump = pool.bump,
        has_one = mint @ PoolError::InvalidMint,
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        init_if_needed,
        payer = payer,
        seeds = [b"position", pool.key().as_ref(), user.key().as_ref()],
        bump,
        space = Position::DISCRIMINATOR.len() + Position::INIT_SPACE,
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
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> Deposit<'info> {
    pub fn deposit(&mut self, amount: u64, bumps: DepositBumps) -> Result<()> {
        require!(!self.pool.paused, PoolError::Paused);
        require!(amount > 0, PoolError::InvalidAmount);

        let now = Clock::get()?.unix_timestamp;

        if self.position.owner == Pubkey::default() {
            self.position.set_inner(Position {
                owner: self.user.key(),
                pool: self.pool.key(),
                principal: 0,
                points: 0,
                last_accrual: now,
                bump: bumps.position,
            });
        }

        accrue(&mut self.position, now)?;

        self.deposit_tokens(amount)?;

        self.position.principal = self
            .position
            .principal
            .checked_add(amount)
            .ok_or(PoolError::MathOverflow)?;
        self.pool.total_principal = self
            .pool
            .total_principal
            .checked_add(amount)
            .ok_or(PoolError::MathOverflow)?;

        emit!(Deposited {
            pool: self.pool.key(),
            user: self.user.key(),
            amount,
            total_principal: self.pool.total_principal,
        });

        Ok(())
    }

    pub fn deposit_tokens(&self, amount: u64) -> Result<()> {
        let cpi_program = self.token_program.to_account_info();

        let cpi_accounts = Transfer {
            from: self.user_ata.to_account_info(),
            to: self.vault.to_account_info(),
            authority: self.user.to_account_info(),
        };

        let ctx = CpiContext::new(cpi_program, cpi_accounts);

        transfer(ctx, amount)
    }
}
