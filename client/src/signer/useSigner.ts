// The ONLY file in the app that imports Privy. Everything else depends on the
// provider-agnostic AppSigner interface (see ./types). Swapping providers means
// touching this file alone.
//
// Privy v3 Solana embedded wallets: phone login, no seed phrase, non-custodial.
// Its signTransaction takes/returns serialized wire bytes, so we bridge to the
// kit `Transaction` shape the rest of the app uses.
import { useCallback, useMemo } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import {
  address,
  getTransactionDecoder,
  getTransactionEncoder,
  type Transaction,
} from "@solana/kit";
import type { AppSigner } from "./types";
import { config } from "../config";
import { makeDevSigner } from "./devKeypairSigner";

// Dev path: a single local keypair, no Privy, no browser wallet. Env-selected.
const devSigner = config.devSigner ? makeDevSigner() : null;

export function useSigner(): AppSigner {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const { signTransaction: privySign } = useSignTransaction();

  const wallet = wallets[0] ?? null;

  const signTransaction = useCallback(
    async (tx: Transaction): Promise<Transaction> => {
      if (!wallet) throw new Error("no connected Solana wallet");
      const wire = getTransactionEncoder().encode(tx);
      const { signedTransaction } = await privySign({
        transaction: new Uint8Array(wire),
        wallet,
      });
      return getTransactionDecoder().decode(signedTransaction);
    },
    [wallet, privySign],
  );

  return useMemo<AppSigner>(() => {
    if (devSigner) return devSigner;
    return {
      address: wallet ? address(wallet.address) : null,
      connected: ready && authenticated && !!wallet,
      connect: async () => {
        login();
      },
      disconnect: async () => {
        await logout();
      },
      signTransaction,
    };
  }, [ready, authenticated, wallet, login, logout, signTransaction]);
}
