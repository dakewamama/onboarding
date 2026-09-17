import * as fs from "fs";
import * as path from "path";
import { KEYSTORE_DIR } from "./config";

/**
 * A recorded, explicit user consent that Axis may pay and transfer on their
 * behalf. This is the artifact that distinguishes "the user asked us to move
 * their funds" from Axis acting unilaterally.
 *
 * In production this is a signed consent tied to authenticated identity (and
 * whatever KYC the license requires), stored durably. Here it is a JSON record.
 */

export type Action = "deposit" | "withdraw";

export interface Authorization {
  userId: string;
  scope: Action[];
  // Per-tx cap in base units. Zero means ZERO: no transfer is permitted until a
  // positive cap is set explicitly. (Previously 0 meant "unlimited", which turned
  // the safest-looking value into the most permissive behaviour.)
  maxAmountPerTx: number;
  grantedAt: string;
}

const AUTH_DIR = path.join(KEYSTORE_DIR, "authorizations");

function authPath(userId: string): string {
  return path.join(AUTH_DIR, `${userId}.json`);
}

export function grant(
  userId: string,
  scope: Action[],
  maxAmountPerTx = 0
): Authorization {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const auth: Authorization = {
    userId,
    scope,
    maxAmountPerTx,
    grantedAt: new Date().toISOString(),
  };
  fs.writeFileSync(authPath(userId), JSON.stringify(auth, null, 2));
  return auth;
}

/**
 * Pure authorization check (no I/O), so it is unit-testable. Fails closed: an
 * unscoped action, a non-positive amount, or an amount over the per-tx cap all
 * throw. With maxAmountPerTx = 0, every positive amount is over the cap — zero
 * means zero.
 */
export function checkAuthorization(
  auth: Authorization,
  action: Action,
  amount: number
): void {
  if (!auth.scope.includes(action)) {
    throw new Error(`user ${auth.userId} has not authorized "${action}"`);
  }
  if (!(amount > 0)) {
    throw new Error(`amount must be a positive number, got ${amount}`);
  }
  if (amount > auth.maxAmountPerTx) {
    throw new Error(
      `amount ${amount} exceeds authorized per-tx max ${auth.maxAmountPerTx}`
    );
  }
}

export function assertAuthorized(
  userId: string,
  action: Action,
  amount: number
): void {
  const file = authPath(userId);
  if (!fs.existsSync(file)) {
    throw new Error(`no authorization on file for ${userId}`);
  }
  const auth: Authorization = JSON.parse(fs.readFileSync(file, "utf8"));
  checkAuthorization(auth, action, amount);
}
