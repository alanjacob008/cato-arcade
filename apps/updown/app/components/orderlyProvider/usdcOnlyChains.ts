import type { API } from "@orderly.network/types";

/**
 * `dataAdapter.chainsList` step: keep only USDC in each chain's `token_infos`.
 *
 * The deposit form offers every token in `token_infos` (useChains ->
 * ui-transfer useOrderlyTokens); with USDC alone the token picker shows no
 * caret and swap/collateral rows never come into play. `nativeToken` (gas
 * symbol) falls back to the chain's `currency_symbol`, and the SDK's deposit
 * target lookup only ever asks for USDC.
 *
 * Side effect: the withdraw form lists tokens the account HOLDS (holdings API,
 * not this list), so a non-USDC holding would show as "can't be withdrawn on
 * this network". Players only ever deposit USDC here.
 *
 * Returns the same array instance when nothing changes.
 */
export const keepOnlyUsdcTokens = (chains: API.Chain[]): API.Chain[] => {
  if (!Array.isArray(chains)) return chains;
  let changed = false;
  const next = chains.map((chain) => {
    const tokens = chain?.token_infos;
    if (!Array.isArray(tokens)) return chain;
    const usdc = tokens.filter((token) => token?.symbol === "USDC");
    if (usdc.length === tokens.length) return chain;
    changed = true;
    return { ...chain, token_infos: usdc };
  });
  return changed ? next : chains;
};
