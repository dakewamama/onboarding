// DEV ONLY. A local keypair standing in for a Privy embedded wallet so the flow
// can be exercised without a browser + Privy app id. Selected by VITE_DEV_SIGNER=1.
//
// The key comes from VITE_DEV_KEYPAIR (a JSON array of 64 bytes, same shape as a
// `solana-keygen` file). This is a throwaway localnet key. NEVER put a funded or
// mainnet secret here, and never commit a real one.
import {
  createKeyPairFromBytes,
  getAddressFromPublicKey,
  partiallySignTransaction,
  type Address,
  type Transaction,
} from "@solana/kit";
import type { AppSigner } from "./types";

let cached: { keyPair: CryptoKeyPair; address: Address } | null = null;

async function load() {
  if (cached) return cached;
  const raw = (import.meta as any).env?.VITE_DEV_KEYPAIR;
  if (!raw) throw new Error("VITE_DEV_KEYPAIR not set (dev signer selected)");
  const bytes = Uint8Array.from(JSON.parse(raw) as number[]);
  const keyPair = await createKeyPairFromBytes(bytes);
  const address = await getAddressFromPublicKey(keyPair.publicKey);
  cached = { keyPair, address };
  return cached;
}

export function makeDevSigner(): AppSigner & { ready: Promise<void> } {
  let address: Address | null = null;
  const ready = load().then((c) => {
    address = c.address;
  });
  return {
    get address() {
      return address;
    },
    get connected() {
      return address !== null;
    },
    ready,
    async connect() {
      const c = await load();
      address = c.address;
    },
    async disconnect() {
      address = null;
    },
    async signTransaction(tx: Transaction): Promise<Transaction> {
      const c = await load();
      return partiallySignTransaction([c.keyPair], tx);
    },
  };
}
