/**
 * Live RPC check for the crypto-funding flow. Proves the watcher can talk to the
 * configured Solana RPC, derive the USDC deposit account, and read confirmed
 * transfers BEFORE any frontend work depends on it. Reads nothing secret and
 * writes nothing on-chain.
 *
 *   SOLANA_RPC_URL=... [SOLANA_USDC_MINT=...] \
 *   npm run funding-rpccheck -- <ownerAddress>
 *
 * With no owner argument it just verifies connectivity + mint + slot.
 */
import { Connection } from "@solana/web3.js";
import { loadFundingConfig } from "./config";
import { DepositLedger } from "./depositLedger";
import { UsdcWatcher } from "./usdcWatcher";
import { fromBaseUnits } from "../money";

async function main() {
  const cfg = loadFundingConfig();
  const owner = process.argv[2];
  const connection = new Connection(cfg.rpcUrl, cfg.commitment);

  console.log(`RPC        ${cfg.rpcUrl}`);
  console.log(`USDC mint  ${cfg.usdcMint}`);
  console.log(`commitment ${cfg.commitment}`);

  const slot = await connection.getSlot();
  console.log(`slot       ${slot}  (connectivity ok)`);

  if (!owner) {
    console.log("\nNo owner address given — connectivity check only. Pass one to scan deposits.");
    return;
  }

  const ledger = new DepositLedger(cfg.storeDir);
  const credited: string[] = [];
  const watcher = new UsdcWatcher(cfg, ledger, (r) => {
    credited.push(`${fromBaseUnits(BigInt(r.baseUnits))} USDC  ${r.signature}`);
  }, connection);

  const ata = watcher.depositAta(owner);
  console.log(`owner      ${owner}`);
  console.log(`deposit    ${ata.toBase58()}  (USDC ATA)`);

  watcher.watch(owner);
  await watcher.scanOwner(owner);

  console.log(`\nbalance    ${fromBaseUnits(ledger.balanceBaseUnits(owner))} USDC (durably credited)`);
  console.log(`new credits this scan: ${credited.length}`);
  for (const c of credited) console.log(`  + ${c}`);
}

main().catch((err) => {
  console.error("rpccheck failed:", err.message);
  process.exit(1);
});
