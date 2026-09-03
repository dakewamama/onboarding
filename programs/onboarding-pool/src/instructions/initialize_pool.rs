use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{Mint, Token, TokenAccount};

use crate::errors::PoolError;
use crate::events::PoolInitialized;
use crate::state::Pool;

#[derive(Accounts)]
#[instruction(seed: u64)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        constraint = treasury.mint == mint.key() @ PoolError::InvalidMint,
    )]
    pub treasury: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = authority,
        seeds = [b"pool", seed.to_le_bytes().as_ref()],
        bump,
        space = Pool::DISCRIMINATOR.len() + Pool::INIT_SPACE,
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        init,
        payer = authority,
        associated_token::mint = mint,
        associated_token::authority = pool,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

impl<'info> InitializePool<'info> {
    pub fn initialize_pool(&mut self, seed: u64, bumps: InitializePoolBumps) -> Result<()> {
        self.pool.set_inner(Pool {
            authority: self.authority.key(),
            pending_authority: Pubkey::default(),
            treasury: self.treasury.key(),
            mint: self.mint.key(),
            seed,
            total_principal: 0,
            paused: false,
            bump: bumps.pool,
        });

        emit!(PoolInitialized {
            pool: self.pool.key(),
            authority: self.pool.authority,
            mint: self.pool.mint,
            treasury: self.pool.treasury,
        });

        Ok(())
    }
}
