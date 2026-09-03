use anchor_lang::prelude::*;

use crate::errors::PoolError;

#[account]
#[derive(InitSpace)]
pub struct Position {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub principal: u64,
    /// Accumulated points, measured in token-seconds (`principal × seconds`).
    /// This is purely informational: it is the return the protocol tracks for a
    /// position, monotonically increasing while principal sits in the pool. There
    /// is no claim path and points mint no reward — nothing on-chain spends them.
    pub points: u128,
    pub last_accrual: i64,
    pub bump: u8,
}

pub fn accrue(position: &mut Position, now: i64) -> Result<()> {
    let elapsed = now
        .checked_sub(position.last_accrual)
        .ok_or(PoolError::MathOverflow)?;
    // Only advance `last_accrual` when time actually moved forward. If the
    // cluster clock rewinds (`elapsed <= 0`) we leave the checkpoint untouched,
    // so a later forward jump accrues from the previous high-water mark rather
    // than re-counting the rewound interval. This keeps points monotonic
    // (invariant 4) and prevents double-counting.
    if elapsed > 0 {
        let delta = (position.principal as u128)
            .checked_mul(elapsed as u128)
            .ok_or(PoolError::MathOverflow)?;
        position.points = position
            .points
            .checked_add(delta)
            .ok_or(PoolError::MathOverflow)?;
        position.last_accrual = now;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn position(principal: u64, last_accrual: i64) -> Position {
        Position {
            owner: Pubkey::default(),
            pool: Pubkey::default(),
            principal,
            points: 0,
            last_accrual,
            bump: 0,
        }
    }

    #[test]
    fn accrues_forward() {
        let mut p = position(100, 0);
        accrue(&mut p, 10).unwrap();
        assert_eq!(p.points, 1_000);
        assert_eq!(p.last_accrual, 10);
    }

    #[test]
    fn backward_is_a_no_op() {
        let mut p = position(100, 10);
        accrue(&mut p, 4).unwrap();
        // Clock rewound: nothing accrues and the checkpoint stays put.
        assert_eq!(p.points, 0);
        assert_eq!(p.last_accrual, 10);
    }

    #[test]
    fn forward_after_backward_does_not_double_count() {
        let mut p = position(100, 10);
        // Rewind to 4 (no-op), then jump forward to 15.
        accrue(&mut p, 4).unwrap();
        accrue(&mut p, 15).unwrap();
        // Only the 10 -> 15 interval counts, not 4 -> 15.
        assert_eq!(p.points, 500);
        assert_eq!(p.last_accrual, 15);
    }
}
