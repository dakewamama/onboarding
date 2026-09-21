import type { Address, Transaction } from "@solana/kit";

// The single signer abstraction the rest of the app talks to.
// Only the concrete implementations (useSigner -> Privy, or devKeypairSigner)
// know how signatures are actually produced. Everything else stays provider-agnostic.
export interface AppSigner {
  address: Address | null;
  connected: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  // Adds ONLY the user's signature to an already-compiled transaction.
  // The gas wallet's signature is added later, server-side (D7 fee sponsorship).
  // Never sends — the client signs, the backend submits.
  signTransaction: (tx: Transaction) => Promise<Transaction>;
}
