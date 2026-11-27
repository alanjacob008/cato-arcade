export type VrfExecution = "base" | "er";

// Public endpoint only: explorer links must never expose a private RPC credential.
const ER_DEVNET_RPC = "https://devnet-as.magicblock.app";

export function vrfExplorerLink(signature: string | null | undefined, execution?: VrfExecution): string | null {
  if (!signature || !/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) || !execution) return null;
  const cluster = execution === "er"
    ? `cluster=custom&customUrl=${encodeURIComponent(ER_DEVNET_RPC)}`
    : "cluster=devnet";
  return `https://explorer.solana.com/tx/${signature}?${cluster}`;
}
