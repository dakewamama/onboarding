use anchor_lang::prelude::*;

use crate::errors::PoolError;
use crate::events::PositionClosed;
use crate::state::Position;

#[derive(Accounts)]
pub struct ClosePosition<'info> {
    pub owner: Signer<'info>,
    /// Receives the position account's rent lamports. Any system account works;
    /// it need not be the owner.
    #[account(mut)]
    pub rent_receiver: SystemAccount<'info>,
    #[account(
        mut,
        seeds = [b"position", position.pool.as_ref(), owner.key().as_ref()],
        bump = position.bump,
        has_one = owner,
        close = rent_receiver,
    )]
    pub position: Account<'info, Position>,
}

impl<'info> ClosePosition<'info> {
    pub fn close_position(&mut self) -> Result<()> {
        // Only a fully-exited position may be closed. Principal conservation
        // (invariant 2) requires that any remaining principal is still counted in
        // the pool, so closing here would strand it.
        require!(self.position.principal == 0, PoolError::PositionNotEmpty);

        emit!(PositionClosed {
            pool: self.position.pool,
            owner: self.owner.key(),
        });

        Ok(())
    }
}
