/**
 * Which Orderly account may the signed-in wallet play with? Exactly the one
 * Orderly derives for that wallet on this broker. The beta session holds a
 * Solana wallet (it signed the /play message), so the lookup uses chain_type=SOL,
 * the same public call the Orderly SDK makes when the game connects a Solana
 * wallet (GET /v1/get_account?address=&broker_id=&chain_type=).
 */
import { HttpError } from "../../updown/server/service.mjs";

type PublicRequest = (path: string) => Promise<any>;

interface Entry {
  accountId: string | null;
  expires: number;
}

const FOUND_TTL_MS = 10 * 60_000;
// Short, so a wallet that registers in the game is recognised within seconds.
const MISSING_TTL_MS = 15_000;
const MAX_ENTRIES = 2_000;
const cache = new Map<string, Entry>();

export const ACCOUNT_ID = /^0x[0-9a-fA-F]{64}$/;
const ACCOUNT_NOT_FOUND = -1607;

/** Test hook. */
export function clearAccountCache(): void {
  cache.clear();
}

/** The wallet's Orderly account id on this broker (lowercase), or null when it has none. Cached per instance. */
export async function orderlyAccountFor(
  wallet: string,
  { request, brokerId, now = Date.now }: { request: PublicRequest; brokerId: string; now?: () => number },
): Promise<string | null> {
  const key = `${brokerId}\n${wallet}`;
  const hit = cache.get(key);
  if (hit && hit.expires > now()) return hit.accountId;
  let accountId: string | null;
  try {
    const data = await request(
      `/v1/get_account?address=${encodeURIComponent(wallet)}&broker_id=${encodeURIComponent(brokerId)}&chain_type=SOL`,
    );
    accountId = typeof data?.account_id === "string" && ACCOUNT_ID.test(data.account_id) ? data.account_id.toLowerCase() : null;
  } catch (error) {
    const { code, message } = (error ?? {}) as { code?: number; message?: string };
    // Orderly answers an unknown wallet with code -1607 "Account not found.".
    // Anything else (outage, rate limit, unknown broker) is not a "no".
    if (code !== ACCOUNT_NOT_FOUND) {
      console.error(`Up Down: Orderly account lookup failed: ${message || "unknown error"}`);
      throw new HttpError(503, "Could not confirm your Orderly account right now. Try again in a moment.");
    }
    accountId = null;
  }
  if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value as string);
  cache.set(key, { accountId, expires: now() + (accountId ? FOUND_TTL_MS : MISSING_TTL_MS) });
  return accountId;
}

/**
 * authorize(accountId) for the game API: passes only for the signed-in wallet's
 * own Orderly account, throws HttpError 400/403 otherwise.
 */
export function accountAuthorizer(
  wallet: string,
  deps: { request: PublicRequest; brokerId: string; now?: () => number },
): (accountId: unknown) => Promise<void> {
  return async (accountId) => {
    if (typeof accountId !== "string" || !ACCOUNT_ID.test(accountId)) throw new HttpError(400, "Invalid account ID.");
    const own = await orderlyAccountFor(wallet, deps);
    if (!own) {
      throw new HttpError(403, "The wallet you signed in with has no Up Down account yet. Connect that wallet in the game to set it up.");
    }
    if (own !== accountId.toLowerCase()) {
      throw new HttpError(403, "This account does not belong to the wallet you signed in with. Connect that wallet, or sign in again at /play.");
    }
  };
}
