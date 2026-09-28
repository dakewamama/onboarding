// Fee-sponsorship backend (D7). Receives a user-signed transaction whose feePayer
// is the gas wallet, adds the gas wallet's signature, and submits it. The user
// never holds SOL and never sends to the chain themselves.
//
// The gas keypair is operator-held and loaded from GAS_WALLET_KEYPAIR. It never
// reaches the client. Do NOT point GAS_WALLET_KEYPAIR at ~/.config/solana/id.json
// or any funded mainnet key while testing.
import "dotenv/config";
import express from "express";
import { readFileSync } from "node:fs";
import {
  createKeyPairFromBytes,
  createSolanaRpc,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  type Transaction,
} from "@solana/kit";

const PORT = Number(process.env.SPONSOR_PORT ?? 8787);
const RPC_URL = process.env.RPC_URL ?? "http://127.0.0.1:8899";
const KEYPAIR_PATH = process.env.GAS_WALLET_KEYPAIR ?? "./.gas-wallet.json";

const rpc = createSolanaRpc(RPC_URL);

async function loadGasKey() {
  const bytes = Uint8Array.from(
    JSON.parse(readFileSync(KEYPAIR_PATH, "utf-8")) as number[],
  );
  const keyPair = await createKeyPairFromBytes(bytes);
  const address = await getAddressFromPublicKey(keyPair.publicKey);
  return { keyPair, address };
}

async function main() {
  const gas = await loadGasKey();
  console.log(`sponsor gas wallet: ${gas.address}`);

  const app = express();
  app.use(express.json({ limit: "128kb" }));

  app.post("/sponsor", async (req, res) => {
    try {
      const b64 = req.body?.transaction as string | undefined;
      if (!b64) return res.status(400).json({ error: "missing transaction" });

      const bytes = Uint8Array.from(Buffer.from(b64, "base64"));
      const tx = getTransactionDecoder().decode(bytes) as Transaction;

      // Only sponsor transactions the gas wallet is actually paying for. Real
      // deployments should also allowlist the program + instruction shape here.
      if (!(gas.address in tx.signatures)) {
        return res
          .status(400)
          .json({ error: "gas wallet is not the fee payer" });
      }

      const signed = await partiallySignTransaction([gas.keyPair], tx);
      const wire = getBase64EncodedWireTransaction(signed);
      const signature = await rpc
        .sendTransaction(wire, { encoding: "base64", skipPreflight: false })
        .send();

      res.json({ signature });
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: String(e) });
    }
  });

  app.listen(PORT, () => console.log(`sponsor listening on :${PORT}`));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
