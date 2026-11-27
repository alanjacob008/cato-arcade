import { useMemo } from "react";
// `swr` is the SWR instance @orderly.network/hooks itself uses (single hoisted
// copy; hooks re-exports useSWR/useSWRConfig from it). We only need the
// SWRConfig provider + Middleware type, which hooks does not re-export.
import type { Middleware } from "swr";
import { applySolscanToChainInfoRows } from "./solana-explorer";

export const CHAIN_INFO_SWR_KEY = "/v1/public/chain_info";

/**
 * SWR middleware that rewrites `explorer_base_url` of the Solana rows in the
 * `/v1/public/chain_info` response. This is the only extension point for
 * `useChainInfo()` in @orderly.network/hooks, which the portfolio asset
 * history (deposit/withdraw tx links) reads directly. Mount it through
 * `<SWRConfig value={{ use: [solscanSwrMiddleware] }}>` above the
 * OrderlyAppProvider; SWR concatenates `use` arrays of nested configs.
 */
export const solscanSwrMiddleware: Middleware =
  (useSWRNext) => (key, fetcher, config) => {
    const swr = useSWRNext(key, fetcher, config);
    const isChainInfo = key === CHAIN_INFO_SWR_KEY;
    const data = swr.data;
    const patched = useMemo(
      () =>
        isChainInfo
          ? applySolscanToChainInfoRows(
              data as Parameters<typeof applySolscanToChainInfoRows>[0],
            )
          : data,
      [isChainInfo, data],
    );
    if (!isChainInfo || patched === data) return swr;
    return Object.assign({}, swr, { data: patched });
  };
