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
    #[msg("No excess available to skim")]
    NothingToSkim,
    #[msg("There is no pending authority to accept")]
    NoPendingAuthority,
    #[msg("Signer is not the pending authority")]
    NotPendingAuthority,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
