import { Pool } from "pg";
import { fundingStoreDir } from "./config";
import { PostgresMoneyLedger } from "./moneyLedger";

/** Copy the legacy JSON-file ledger into Axis Money. Safe to re-run. */
async function main(): Promise<void> {
  const url = process.env.MONEY_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const dir = process.argv[2] ?? fundingStoreDir(process.env);
  const ledger = new PostgresMoneyLedger(new Pool({ connectionString: url }));
  try {
    const report = await ledger.importFileLedger(dir);
    console.log(JSON.stringify({ dir, ...report }));
    if (report.negativeOwners.length) process.exitCode = 2;
  } finally {
    await ledger.close();
  }
}
void main().catch(error => { console.error(error); process.exit(1); });
