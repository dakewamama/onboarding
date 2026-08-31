use anchor_lang::prelude::*;

#[event]
pub struct PoolInitialized {
    pub pool: Pubkey,
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub treasury: Pubkey,
}

#[event]
pub struct Deposited {
    pub pool: Pubkey,
    pub user: Pubkey,
    pub amount: u64,
    pub total_principal: u64,
}
