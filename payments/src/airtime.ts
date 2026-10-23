import * as http from "http";
import { bearerAuthorized, readJson, send } from "./httpUtil";
import { URL } from "url";
import { VtpassClient, VtpassEnv, serviceIdFor } from "./vtpassClient";
import { InsufficientBalanceError } from "./funding/spendLedger";
import { openMoneyLedger, SpendKeyVoidedError } from "./funding/moneyLedger";
import { fundingStoreDir } from "./funding/config";
import { usdcToNgnRate, offRampNgnPerUsdc } from "./rate";
import { fulfillAirtime, requeryAirtime, AirtimeIdentityConflict, AirtimeFulfillDeps } from "./airtimeFulfill";
import { IdentityStore } from "./identity";
import { provisionWallet, walletAddressFor } from "./custody";
import { PublicKey } from "@solana/web3.js";
import { PajClient } from "./pajClient";
import type { Currency } from "./types";

/**
 * Authenticated airtime fulfilment, mounted next to the off-ramp + webhook
 * receiver. This is the ONLY place that talks to VTpass outbound with the secret
 * key. The brain calls it to buy airtime; it is gated by INTERNAL_API_TOKEN so
 * the public URL can't.
 *
 * It RESERVES the debit (SpendLedger, balance-checked + idempotent), DELIVERS via
 * VTpass, and releases the debit only on confirmed failure. The remnant is
 * booked as pool gain only once settled. Unknown results retain the debit as
 * IN_DOUBT. Missing VTpass keys, token, or rate prevents new purchases.
 */
export interface AirtimeMount {
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<boolean>;
  logStatus(port: number): void;
}

export function mountAirtime(
  env: NodeJS.ProcessEnv = process.env,
  armWatch?: ((owner: string) => void) | null,
): AirtimeMount {
  const token = env.INTERNAL_API_TOKEN;
  const apiKey = env.VTPASS_API_KEY;
  const secretKey = env.VTPASS_SECRET_KEY;
  const publicKey = env.VTPASS_PUBLIC_KEY;
  const vtEnv: VtpassEnv = env.VTPASS_ENV === "live" ? "live" : "sandbox";
  const client =
    apiKey && secretKey
      ? new VtpassClient({ apiKey, secretKey, publicKey, env: vtEnv })
      : null;
  // Rate: prefer Paj's live off-ramp rate (settlement-consistent, fee included);
  // fall back to a static env rate if Paj isn't configured/reachable.
  const pajApiKey = env.PAJ_API_KEY;
  const pajEnv = env.PAJ_ENV === "production" ? "production" : "staging";
  const pajClient = pajApiKey ? new PajClient({ apiKey: pajApiKey, env: pajEnv }) : null;
  let staticRate: number | null;
  try {
    staticRate = usdcToNgnRate(env);
  } catch {
    staticRate = null;
  }
  const rateAvailable = Boolean(pajClient || staticRate);

  async function resolveRate(): Promise<{ rate: number; source: "paj" | "fallback" }> {
    if (pajClient) {
      try {
        const v = offRampNgnPerUsdc(await pajClient.getRate("NGN" as Currency));
        if (v) return { rate: v, source: "paj" };
      } catch {
        // fall through to the static fallback
      }
    }
    if (staticRate) return { rate: staticRate, source: "fallback" };
    throw new Error("no rate available (set PAJ_API_KEY or AXIS_USDC_NGN_RATE)");
  }
  async function getRate(): Promise<number> {
    return (await resolveRate()).rate;
  }

  const marginBps = Number(env.AXIS_AIRTIME_MARGIN_BPS ?? 0) || 0;
  const enabled = Boolean(token && client && rateAvailable);
  const disabledReason = !token
    ? "INTERNAL_API_TOKEN not set"
    : !client
      ? "VTPASS_API_KEY/VTPASS_SECRET_KEY not set"
      : !rateAvailable
        ? "no rate (set PAJ_API_KEY or AXIS_USDC_NGN_RATE)"
        : "";

  const storeDir = fundingStoreDir(env);
  const ledger = openMoneyLedger(env, storeDir);
  const identity = new IdentityStore(storeDir);
  const deps: AirtimeFulfillDeps = {
    getRate,
    marginBps,
    spend: input => ledger.spend(input),
    getSpend: (owner, key) => ledger.get(owner, key),
    findSpend: key => ledger.findByKey(key),
    voidUnknownKey: (key, reason) => ledger.voidUnknownKey(key, reason),
    setState: (owner, key, state) => ledger.setState(owner, key, state),
    requery: requestId => client!.requery(requestId),
    buyAirtime: (p) => client!.buyAirtime(p),
  };

  const authorized = (req: http.IncomingMessage) => bearerAuthorized(req, token);

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<boolean> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const routes = ["/airtime/status", "/airtime", "/airtime/link", "/airtime/provision", "/airtime/rate", "/wallet", "/wallet/balance"];
    if (!routes.includes(url.pathname)) return false;

    // Token gates everything. The VTpass/rate `enabled` gate applies only to the
    // buy route below — provisioning/linking must work before airtime is keyed.
    if (!token) return void send(res, 503, { error: "INTERNAL_API_TOKEN not set" }), true;
    if (!authorized(req)) return void send(res, 401, { error: "unauthorized" }), true;

    if (url.pathname === "/airtime/status") {
      if (req.method !== "GET") return void send(res, 405, { error: "method" }), true;
      const key = url.searchParams.get("idempotencyKey");
      if (!key) return void send(res, 400, { error: "idempotencyKey required" }), true;
      try {
        const verdict = await requeryAirtime(deps, key);
        if (!verdict) return void send(res, 202, { status: "in_doubt", moneyState: "IN_DOUBT" }), true;
        if (verdict.status === "failed" && verdict.reason === "not_submitted") return void send(res, 200, verdict), true;
        return void send(res, verdict.status === "in_doubt" || verdict.status === "pending" ? 202 : 200, verdict), true;
      } catch {
        return void send(res, 202, { status: "in_doubt", moneyState: "IN_DOUBT" }), true;
      }
    }

    // Spendable balance for a user (deposits minus spends), with an NGN estimate.
    // GET ?userId=... — resolves the user's wallet, sums the ledgers. No wallet or
    // no deposits => 0, not an error.
    if (url.pathname === "/wallet/balance") {
      const userId = url.searchParams.get("userId") ?? "";
      if (!userId) return void send(res, 400, { error: "userId required" }), true;
      const address = identity.addressFor(userId);
      const base = address
        ? await ledger.availableBaseUnits(address)
        : BigInt(0);
      const usdc = Number(base) / 1e6;
      let ngn: number | null = null;
      try {
        ngn = Math.floor(usdc * (await getRate()));
      } catch {
        ngn = null;
      }
      return (
        void send(res, 200, { userId, baseUnits: base.toString(), usdc, ngn }),
        true
      );
    }

    // Diagnostic: which rate is live and where from (proves Paj vs fallback). GET.
    if (url.pathname === "/airtime/rate") {
      try {
        return void send(res, 200, await resolveRate()), true;
      } catch (e) {
        return void send(res, 503, { error: (e as Error).message }), true;
      }
    }

    if (req.method !== "POST") return void send(res, 405, { error: "method" }), true;

    let buyKey = "";
    try {
      let body: Record<string, unknown>;
      try {
        body = await readJson(req);
      } catch {
        return void send(res, 400, { error: "invalid JSON" }), true;
      }

      // THE user's wallet: create it once (idempotent), link userId <-> address,
      // and arm the deposit watch so any USDC sent to it is credited. This is what
      // auth calls — one wallet per user, billed for everything. (/airtime/provision
      // is a legacy alias for the same thing.) Needs only KEYSTORE_MASTER_KEY.
      if (url.pathname === "/wallet" || url.pathname === "/airtime/provision") {
        const userId = String(body.userId ?? "");
        if (!userId) return void send(res, 400, { error: "userId is required" }), true;
        let wallet: { userId: string; address: string; created: boolean };
        try {
          wallet = provisionWallet(storeDir, userId, env);
        } catch (e) {
          return void send(res, 503, { error: (e as Error).message }), true;
        }
        try {
          identity.link(userId, wallet.address);
        } catch (e) {
          return void send(res, 409, { error: (e as Error).message }), true;
        }
        try {
          armWatch?.(wallet.address); // credit deposits to this wallet automatically
        } catch (e) {
          // The balance still reconciles once the watch is armed on a later call.
          console.warn("[wallet] could not arm deposit watch:", (e as Error).message);
        }
        return void send(res, 200, wallet), true;
      }

      // Link a userId to an externally-held wallet (manual path). A user with an
      // Axis custodial wallet stays on it: their balance is keyed by that address.
      if (url.pathname === "/airtime/link") {
        const userId = String(body.userId ?? "");
        const address = String(body.address ?? "");
        if (!userId || !address) {
          return void send(res, 400, { error: "userId and address are required" }), true;
        }
        try {
          new PublicKey(address);
        } catch {
          return void send(res, 400, { error: "address is not a Solana public key" }), true;
        }
        const custodial = walletAddressFor(storeDir, userId);
        if (custodial && custodial !== address) {
          return void send(res, 409, { error: "user already has an Axis wallet" }), true;
        }
        try {
          identity.link(userId, address);
        } catch (e) {
          return void send(res, 409, { error: (e as Error).message }), true;
        }
        return void send(res, 200, { userId, address }), true;
      }

      // From here on it's the buy route, which needs VTpass + rate configured.
      const rawOwner = String(body.owner ?? "");
      const network = String(body.network ?? "");
      const phone = String(body.phone ?? "");
      const idempotencyKey = String(body.idempotencyKey ?? "");
      buyKey = idempotencyKey;
      if (!enabled) return void (await rejectBeforeDebit(res, idempotencyKey, 503, "not_debited", disabledReason)), true;
      const amount = body.amount != null ? Number(body.amount) : NaN;
      if (!rawOwner || !network || !phone || !idempotencyKey || !Number.isFinite(amount) || !(amount > 0) || !serviceIdFor(network)) {
        return void (await rejectBeforeDebit(res, idempotencyKey, 400, "invalid_request",
          "owner, network, phone, idempotencyKey and a positive amount are required")), true;
      }
      // Resolve to the single money key: the custodial wallet address deposits are
      // credited under. rawOwner is normally a userId; accept a linked address too.
      let owner: string;
      const mapped = identity.addressFor(rawOwner);
      if (mapped) {
        owner = mapped; // rawOwner was a userId
      } else if (identity.userFor(rawOwner)) {
        owner = rawOwner; // rawOwner was already the linked address
      } else {
        return void (await rejectBeforeDebit(res, idempotencyKey, 409, "no_wallet",
          "no wallet linked for this user; call /airtime/link first")), true;
      }
      const result = await fulfillAirtime(deps, {
        owner,
        network,
        amount,
        phone,
        idempotencyKey,
      });
      const status =
        result.status === "delivered"
          ? 200
          : (result.status === "pending" || result.status === "in_doubt")
            ? 202
            : 502; // failed
      return void send(res, status, result), true;
    } catch (err) {
      if (err instanceof AirtimeIdentityConflict) return void send(res, 409, { error: err.message }), true;
      if (err instanceof InsufficientBalanceError) {
        return void send(res, 402, { error: "insufficient balance", status: "failed", moneyState: "RELEASED", reason: "insufficient_balance" }), true;
      }
      if (err instanceof SpendKeyVoidedError) {
        return void send(res, 409, { status: "failed", moneyState: "RELEASED", reason: "voided" }), true;
      }
      // Never leak the key; surface a generic error.
      console.error("[airtime] error", (err as Error).message);
      if (buyKey) {
        try { return void (await rejectBeforeDebit(res, buyKey, 503, "not_debited", "airtime unavailable")), true; }
        catch { /* the ledger itself is unreachable: the outcome stays unknown */ }
      }
      return void send(res, 202, { status: "in_doubt", moneyState: "IN_DOUBT" }), true;
    }
  }

  /**
   * A purchase refused before any debit. Void the key so no later request can
   * debit under it, then answer definitively. If a debit somehow exists, report it.
   */
  async function rejectBeforeDebit(res: http.ServerResponse, key: string, code: number, reason: string, error: string): Promise<void> {
    const existing = key ? await ledger.voidUnknownKey(key, reason) : null;
    if (existing) {
      const verdict = await requeryAirtime(deps, key);
      return send(res, verdict && verdict.status !== "in_doubt" && verdict.status !== "pending" ? 200 : 202, verdict ?? { status: "in_doubt", moneyState: "IN_DOUBT" });
    }
    send(res, code, { error, status: "failed", moneyState: "RELEASED", reason });
  }

  function logStatus(_port: number): void {
    console.log(
      enabled
        ? `[airtime] routes enabled (/airtime buy + /wallet + /airtime/link, VTpass ${vtEnv})`
        : `[airtime] buy disabled (${disabledReason}); /wallet still available if INTERNAL_API_TOKEN is set`,
    );
  }

  return { handle, logStatus };
}
