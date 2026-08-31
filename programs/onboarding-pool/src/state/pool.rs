use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub mint: Pubkey,
    pub seed: u64,
    pub total_principal: u64,
    pub paused: bool,
    pub bump: u8,
}
