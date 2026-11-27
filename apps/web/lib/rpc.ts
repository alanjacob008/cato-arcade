/** RPC endpoint for browser-side Solana calls (wallet adapter, Anchor, SPL). */
export function getWebRpcEndpoint(): string {
  // Only a keyless endpoint may be set here (e.g. https://api.devnet.solana.com for local
  // devnet work): NEXT_PUBLIC_* is inlined into public JavaScript, and the build refuses
  // keyed values (lib/publicEnvGuard.mjs).
  const explicit = process.env.NEXT_PUBLIC_RPC_URL?.trim();
  if (explicit) return explicit;

  // Production: the same-origin proxy reads the keyed RPC from server-only variables.
  // web3.js requires an absolute http(s) URL, and pages are also pre-rendered on the
  // server, where there is no window: use the configured site URL there.
  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : process.env.NEXT_PUBLIC_SITE_URL?.trim() || "http://localhost:3000";
  return `${origin.replace(/\/+$/, "")}/api/rpc`;
}
