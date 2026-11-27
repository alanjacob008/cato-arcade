import type { NetworkId } from "@orderly.network/types";

/** Solana is the home chain for Cato. */
export const SOLANA_MAINNET_CHAIN_ID = 900900900;
export const SOLANA_DEVNET_CHAIN_ID = 901901901;

export const SOLANA_DEFAULT_CHAIN = {
  mainnet: { id: SOLANA_MAINNET_CHAIN_ID },
  testnet: { id: SOLANA_DEVNET_CHAIN_ID },
};

export const solanaChainIdFor = (networkId: NetworkId) =>
  networkId === "mainnet" ? SOLANA_MAINNET_CHAIN_ID : SOLANA_DEVNET_CHAIN_ID;

/** Orderly's persisted chain (hooks `useStorageChain`). */
const SDK_CHAIN_KEY = "order:chain";
const MIGRATION_KEY = "updown:solana-default-chain";
const SOLANA_IDS = new Set([SOLANA_MAINNET_CHAIN_ID, SOLANA_DEVNET_CHAIN_ID]);

/**
 * Before Solana became the default, the SDK auto-picked the first chain in its
 * list (Arbitrum) and persisted it. A persisted chain beats `defaultChain`, so
 * clear a non-Solana pick once; later explicit choices are kept.
 */
export function resetAutoSelectedChainOnce(storage: Storage | undefined) {
  if (!storage) return;
  try {
    if (storage.getItem(MIGRATION_KEY)) return;
    const raw = storage.getItem(SDK_CHAIN_KEY);
    const stored = raw ? (JSON.parse(raw) as { chainId?: unknown }) : null;
    if (stored && !SOLANA_IDS.has(Number(stored.chainId))) {
      storage.removeItem(SDK_CHAIN_KEY);
    }
    storage.setItem(MIGRATION_KEY, "1");
  } catch {
    // Storage blocked or malformed: the SDK falls back to defaultChain.
  }
}
