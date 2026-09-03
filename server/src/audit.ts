import * as fs from "fs";
import * as path from "path";
import { AUDIT_DIR } from "./config";

/**
 * Append-only audit trail. Every custodial action — key creation, consent, and
 * each signature Axis produces on a user's behalf — is recorded. In production
 * this belongs in a tamper-evident / WORM store, not a local file.
 */
export function record(event: Record<string, unknown>): void {
  fs.mkdirSync(AUDIT_DIR, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...event });
  fs.appendFileSync(path.join(AUDIT_DIR, "audit.log"), line + "\n");
}

export function tail(n: number): string[] {
  const file = path.join(AUDIT_DIR, "audit.log");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(-n);
}
