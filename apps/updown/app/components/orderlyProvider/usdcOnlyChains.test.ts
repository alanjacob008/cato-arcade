// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { API } from "@orderly.network/types";
import { keepOnlyUsdcTokens } from "./usdcOnlyChains";

const chain = (id: number, symbols: string[]) =>
  ({ network_infos: { chain_id: id, name: `chain-${id}` }, token_infos: symbols.map((symbol) => ({ symbol })) }) as unknown as API.Chain;

describe("keepOnlyUsdcTokens", () => {
  it("drops every token but USDC and keeps the chain itself", () => {
    const [arb, sol] = keepOnlyUsdcTokens([chain(42161, ["USDC", "USDT", "ETH", "WBTC"]), chain(900900900, ["USDC"])]);
    expect(arb.token_infos.map((t) => t.symbol)).toEqual(["USDC"]);
    expect(arb.network_infos.chain_id).toBe(42161);
    expect(sol.token_infos.map((t) => t.symbol)).toEqual(["USDC"]);
  });

  it("returns the same instances when nothing changes", () => {
    const list = [chain(900900900, ["USDC"])];
    expect(keepOnlyUsdcTokens(list)).toBe(list);
    const changed = keepOnlyUsdcTokens([list[0], chain(1, ["USDC", "ETH"])]);
    expect(changed[0]).toBe(list[0]);
  });

  it("tolerates missing data", () => {
    expect(keepOnlyUsdcTokens(undefined as unknown as API.Chain[])).toBeUndefined();
    const bare = { network_infos: { chain_id: 1 } } as unknown as API.Chain;
    expect(keepOnlyUsdcTokens([bare])[0]).toBe(bare);
  });
});
