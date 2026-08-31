use anchor_lang::prelude::*;

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub treasury: Pubkey,
}
