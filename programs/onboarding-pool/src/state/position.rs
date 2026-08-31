use anchor_lang::prelude::*;

use crate::errors::PoolError;

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

pub fn accrue(position: &mut Position, now: i64) -> Result<()> {
    let elapsed = now
        .checked_sub(position.last_accrual)
        .ok_or(PoolError::MathOverflow)?;
    if elapsed > 0 {
        let delta = (position.principal as u128)
            .checked_mul(elapsed as u128)
            .ok_or(PoolError::MathOverflow)?;
        position.accrued_units = position
            .accrued_units
            .checked_add(delta)
            .ok_or(PoolError::MathOverflow)?;
    }
    position.last_accrual = now;
    Ok(())
}
