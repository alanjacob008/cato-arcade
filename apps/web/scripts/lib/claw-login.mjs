import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Newest sign-ins kept per wallet. Logging in again revokes that wallet's older sessions. */
export const WALLET_SESSION_LIMIT = 5;
/** Expired challenge and session rows are pruned at most this often, by reconciliation rather than sign-in. */
export const LOGIN_PRUNE_INTERVAL_MS = 60_000;

/**
 * Challenge nonces end with a MAC over the wallet, random salt and issue time, keyed by this
 * process. The challenge id and the signed message keep their existing format, but a client
 * can no longer choose its own nonce or "Issued" time, so a proof cannot be signed now for a
 * future time window. Challenges are valid for one minute, so a restart only voids those in flight.
 */
export function createChallengeNonces(scope, key = randomBytes(32)) {
  const tag = (wallet, salt, issued) => createHmac("sha256", key).update(`${scope}\n${wallet}\n${salt}\n${issued}`).digest().subarray(0, 16);
  return {
    issue(wallet, issued) { const salt = randomBytes(16).toString("hex"); return salt + tag(wallet, salt, issued).toString("hex"); },
    // The caller has already checked that nonce is 64 lowercase hex characters.
    valid: (wallet, nonce, issued) => timingSafeEqual(Buffer.from(nonce.slice(32), "hex"), tag(wallet, nonce.slice(0, 32), issued)),
  };
}
