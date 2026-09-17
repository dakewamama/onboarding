import { timingSafeEqual } from "crypto";

/**
 * Bearer-token check for the custody server. This server can create users, grant
 * withdraw scope, and sign transfers of real principal, so every route requires
 * it. Fails CLOSED: if no token is configured, nothing is authorized — an
 * unauthenticated custody server must not be reachable, not wide open.
 */
export function bearerOk(
  authHeader: string | undefined,
  token: string | undefined
): boolean {
  if (!token) return false; // fail closed: no token configured => deny all
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const provided = authHeader.slice("Bearer ".length);
  const a = Buffer.from(provided);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
