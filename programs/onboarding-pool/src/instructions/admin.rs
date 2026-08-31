use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, TokenAccount};

use crate::errors::PoolError;
use crate::state::Pool;

#[derive(Accounts)]
pub struct SetPaused<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [b"pool", pool.seed.to_le_bytes().as_ref()],
        bump = pool.bump,
        has_one = authority,
    )]
    pub pool: Account<'info, Pool>,
}

impl<'info> SetPaused<'info> {
    pub fn set_paused(&mut self, paused: bool) -> Result<()> {
        self.pool.paused = paused;
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(treasury: Pubkey)]
pub struct SetTreasury<'info> {
    pub authority: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        seeds = [b"pool", pool.seed.to_le_bytes().as_ref()],
        bump = pool.bump,
        has_one = authority,
        has_one = mint @ PoolError::InvalidMint,
    )]
    pub pool: Account<'info, Pool>,
    #[account(
        address = treasury,
        token::mint = mint,
    )]
    pub new_treasury: Account<'info, TokenAccount>,
}

impl<'info> SetTreasury<'info> {
    pub fn set_treasury(&mut self, treasury: Pubkey) -> Result<()> {
        self.pool.treasury = treasury;
        Ok(())
    }
}
