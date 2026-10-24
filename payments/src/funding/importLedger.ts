import { Pool } from "pg";
import { fundingStoreDir } from "./config";
import { PostgresMoneyLedger } from "./moneyLedger";
import { importTransferFiles } from "./transferStore";
import { PostgresWalletAccounts } from "../accounts";

/** Copy the legacy JSON files (ledger, transfers, wallets, identity links) into Postgres. Safe to re-run. */
async function main(): Promise<void> {
  const url = process.env.MONEY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const dir = process.argv[2] ?? fundingStoreDir(process.env);
  const ledger = new PostgresMoneyLedger(new Pool({ connectionString: url }));
  try {
    const report = await ledger.importFileLedger(dir);
    const transfers = await importTransferFiles(ledger, dir);
    const accounts = await new PostgresWalletAccounts(ledger.pool).importFiles(dir);
    console.log(JSON.stringify({ dir, ...report, transfers, accounts }));
    // Unresolved wallet files hold keys with no known owner: stop and look before going on.
    if (report.negativeOwners.length || accounts.unresolved.length) process.exitCode = 2;
  } finally {
    await ledger.close();
  }
}
void main().catch(error => { console.error(error); process.exit(1); });
