import {
  SOLANA_MAINNET_CHAINID,
  SOLANA_TESTNET_CHAINID,
  type API,
} from "@orderly.network/types";

/**
 * Solscan as the default Solana block explorer.
 *
 * The Orderly SDK never hard-codes an explorer in the UI packages: every
 * explorer link is built from `explorer_base_url` of the chain row returned by
 * `/v1/public/chain_info` (mainnet row: "https://explorer.solana.com",
 * devnet fallback in @orderly.network/types: ".../?cluster=devnet"). The SDK
 * then appends `/tx/<sig>` (portfolio asset history, deposit/withdraw status)
 * or `/address/<addr>` (account menu "view on explorer").
 *
 * That chain row reaches the UI through two independent paths:
 *   1. `useChains()` (zustand chain-info store -> `formatChains`), which exposes
 *      the supported `dataAdapter.chainsList` hook. Used by ui-transfer
 *      (deposit/withdraw dialogs) and ui-scaffold (account menu).
 *   2. `useChainInfo()` (plain SWR `useQuery("/v1/public/chain_info")`), which
 *      has no adapter hook. Used by @orderly.network/portfolio asset history.
 *      Patched via an SWR middleware (see solscan-swr-middleware.ts).
 *
 * Devnet limitation: the SDK templates are `${base}/tx/${sig}`, so a query
 * string (`?cluster=devnet`) cannot be carried by the base URL. Solscan devnet
 * links therefore resolve against mainnet Solscan. The SDK default is equally
 * broken on devnet ("https://explorer.solana.com/?cluster=devnet/tx/<sig>").
 */
export const SOLSCAN_BASE_URL = "https://solscan.io";

export const SOLSCAN_EXPLORER_BASE_URLS: Readonly<Record<number, string>> = {
  [SOLANA_MAINNET_CHAINID]: SOLSCAN_BASE_URL,
  [SOLANA_TESTNET_CHAINID]: SOLSCAN_BASE_URL,
};

export const getSolscanExplorerBaseUrl = (
  chainId: number | string | undefined,
): string | undefined => {
  if (chainId === undefined || chainId === null) return undefined;
  const id = Number(chainId);
  if (!Number.isFinite(id)) return undefined;
  return SOLSCAN_EXPLORER_BASE_URLS[id];
};

/** Build a Solscan URL by hand (for app-owned links, outside the SDK). */
export const solscanTxUrl = (signature: string, devnet = false): string =>
  `${SOLSCAN_BASE_URL}/tx/${signature}${devnet ? "?cluster=devnet" : ""}`;

export const solscanAccountUrl = (address: string, devnet = false): string =>
  `${SOLSCAN_BASE_URL}/account/${address}${devnet ? "?cluster=devnet" : ""}`;

type ChainInfoRowLike = {
  chain_id: string | number;
  explorer_base_url?: string;
};

/**
 * Patch raw `/v1/public/chain_info` rows (shape used by `useChainInfo()`).
 * Returns the same array instance when nothing changes.
 */
export const applySolscanToChainInfoRows = <T extends ChainInfoRowLike>(
  rows: T[] | null | undefined,
): T[] | null | undefined => {
  if (!Array.isArray(rows)) return rows;
  let changed = false;
  const next = rows.map((row) => {
    const override = getSolscanExplorerBaseUrl(row?.chain_id);
    if (!override || row.explorer_base_url === override) return row;
    changed = true;
    return { ...row, explorer_base_url: override };
  });
  return changed ? next : rows;
};

/**
 * `dataAdapter.chainsList` implementation: patch the `network_infos` of the
 * formatted chains returned by `useChains()`.
 */
export const applySolscanToChains = (chains: API.Chain[]): API.Chain[] => {
  if (!Array.isArray(chains)) return chains;
  let changed = false;
  const next = chains.map((chain) => {
    const override = getSolscanExplorerBaseUrl(chain?.network_infos?.chain_id);
    if (!override || chain.network_infos.explorer_base_url === override) {
      return chain;
    }
    changed = true;
    return {
      ...chain,
      network_infos: { ...chain.network_infos, explorer_base_url: override },
    };
  });
  return changed ? next : chains;
};
