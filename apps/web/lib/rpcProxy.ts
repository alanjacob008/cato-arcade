import idl from "../../../idl/stake_rewards.json";

/**
 * Request policy for the public same-origin RPC proxy (app/api/rpc). The proxy exists
 * so the browser can use the server's keyed RPC without seeing the key. Because it is
 * public, it only relays what the site's wallet, staking and token-logo code calls, in
 * small requests; anything else would let anyone spend the key's quota as a free
 * general-purpose RPC.
 */
export const MAX_RPC_BODY_BYTES = 64 * 1024;
export const MAX_RPC_BATCH = 10;
export const ALLOWED_RPC_METHODS: ReadonlySet<string> = new Set([
  "getAccountInfo",
  "getMultipleAccounts",
  "getBalance",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getLatestBlockhash",
  "isBlockhashValid",
  "getBlockHeight",
  "getSlot",
  "getEpochInfo",
  "getGenesisHash",
  "getVersion",
  "getHealth",
  "getSignatureStatuses",
  "getFeeForMessage",
  "getRecentPrioritizationFees",
  "getMinimumBalanceForRentExemption",
  "simulateTransaction",
  "sendTransaction",
  // Only for the stake-rewards program (pool stats in hooks/useStakingStats.ts).
  "getProgramAccounts",
]);
const STAKE_PROGRAM_ID: string = idl.address;

/**
 * The body to relay upstream, or why it may not be relayed. The relayed body is the
 * re-serialised value that was checked, never the caller's raw text: a raw body with
 * repeated keys (e.g. two "method" members) could be read one way here and another
 * way by the upstream parser.
 */
export function rpcRelayBody(body: string): { body: string } | { error: string } {
  const error = rpcRequestError(body);
  if (error) return { error };
  return { body: JSON.stringify(JSON.parse(body)) };
}

/** Read at most `limit` bytes of a request body; null when it is longer (the rest is not read). */
export async function readBodyCapped(stream: ReadableStream<Uint8Array> | null, limit: number): Promise<string | null> {
  if (!stream) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Why a JSON-RPC body may not be relayed, or null when it may. */
export function rpcRequestError(body: string): string | null {
  if (new TextEncoder().encode(body).length > MAX_RPC_BODY_BYTES) return "Request too large";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "Invalid JSON";
  }
  const calls = Array.isArray(parsed) ? parsed : [parsed];
  if (calls.length === 0 || calls.length > MAX_RPC_BATCH) return "Batch too large";
  for (const call of calls) {
    if (!call || typeof call !== "object") return "Invalid request";
    const { method, params } = call as { method?: unknown; params?: unknown };
    if (typeof method !== "string" || !ALLOWED_RPC_METHODS.has(method)) return "Method not allowed";
    if (method === "getProgramAccounts" && !(Array.isArray(params) && params[0] === STAKE_PROGRAM_ID)) {
      return "Method not allowed";
    }
  }
  return null;
}

/** A browser request from another site (Origin present and not this host) is refused. */
export function rpcOriginAllowed(origin: string | null, host: string | null): boolean {
  if (!origin) return true;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
