use anchor_lang::prelude::*;

#[error_code]
pub enum PoolError {
    #[msg("Pool is paused")]
    Paused,
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Withdrawal exceeds available principal")]
    InsufficientPrincipal,
    #[msg("Treasury does not match the pool treasury")]
    InvalidTreasury,
    #[msg("Token account mint does not match the pool mint")]
    InvalidMint,
    #[msg("No yield available to sweep")]
    NothingToSweep,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
