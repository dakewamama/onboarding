use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub principal: u64,
    pub accrued_units: u128,
    pub last_accrual: i64,
    pub bump: u8,
}
