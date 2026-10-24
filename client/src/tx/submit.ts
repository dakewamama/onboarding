import { getBase64EncodedWireTransaction, type Transaction } from "@solana/kit";
import { config } from "../config";

// Ships a user-signed (but not yet gas-signed) transaction to the sponsor
// backend. The client NEVER sends to the chain itself — the backend adds the gas
// wallet's signature and submits. Returns the transaction signature.
export async function submit(signed: Transaction): Promise<string> {
  const wire = getBase64EncodedWireTransaction(signed);
  const res = await fetch(config.sponsorUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ transaction: wire }),
  });
  if (!res.ok) {
    throw new Error(`sponsor rejected: ${res.status} ${await res.text()}`);
  }
  const { signature } = (await res.json()) as { signature: string };
  return signature;
}
