import { describe, expect, it } from "vitest";
import type { API } from "@orderly.network/types";
import {
  applySolscanToChainInfoRows,
  applySolscanToChains,
  getSolscanExplorerBaseUrl,
  solscanAccountUrl,
  solscanTxUrl,
} from "./solana-explorer";

describe("getSolscanExplorerBaseUrl", () => {
  it("maps Solana mainnet and devnet chain ids (number or string)", () => {
    expect(getSolscanExplorerBaseUrl(900900900)).toBe("https://solscan.io");
    expect(getSolscanExplorerBaseUrl("900900900")).toBe("https://solscan.io");
    expect(getSolscanExplorerBaseUrl("901901901")).toBe("https://solscan.io");
  });

  it("leaves non-Solana chains alone", () => {
    expect(getSolscanExplorerBaseUrl(42161)).toBeUndefined();
    expect(getSolscanExplorerBaseUrl(undefined)).toBeUndefined();
    expect(getSolscanExplorerBaseUrl("abc")).toBeUndefined();
  });
});

describe("applySolscanToChainInfoRows", () => {
  const rows = [
    { chain_id: "42161", name: "Arbitrum", explorer_base_url: "https://arbiscan.io" },
    { chain_id: "900900900", name: "Solana", explorer_base_url: "https://explorer.solana.com" },
    { chain_id: "901901901", name: "Solana-Devnet", explorer_base_url: "https://explorer.solana.com/?cluster=devnet" },
  ];

  it("rewrites only the Solana rows and produces SDK-compatible tx links", () => {
    const out = applySolscanToChainInfoRows(rows)!;
    expect(out[0]).toBe(rows[0]);
    expect(out[1].explorer_base_url).toBe("https://solscan.io");
    expect(out[2].explorer_base_url).toBe("https://solscan.io");
    // Same template the SDK uses in portfolio asset history.
    expect(`${out[1].explorer_base_url}/tx/abc`).toBe("https://solscan.io/tx/abc");
  });

  it("does not mutate the input and keeps identity when nothing changes", () => {
    const out = applySolscanToChainInfoRows(rows)!;
    expect(rows[1].explorer_base_url).toBe("https://explorer.solana.com");
    expect(applySolscanToChainInfoRows(out)).toBe(out);
    expect(applySolscanToChainInfoRows([rows[0]])).toEqual([rows[0]]);
    expect(applySolscanToChainInfoRows(undefined)).toBeUndefined();
    expect(applySolscanToChainInfoRows(null)).toBeNull();
  });
});

describe("applySolscanToChains (dataAdapter.chainsList)", () => {
  const chain = (chain_id: number, explorer_base_url: string) =>
    ({
      network_infos: { chain_id, explorer_base_url, name: String(chain_id) },
      token_infos: [],
    }) as unknown as API.Chain;

  it("patches network_infos.explorer_base_url for Solana only", () => {
    const input = [chain(42161, "https://arbiscan.io"), chain(900900900, "https://explorer.solana.com")];
    const out = applySolscanToChains(input);
    expect(out[0]).toBe(input[0]);
    expect(out[1].network_infos.explorer_base_url).toBe("https://solscan.io");
    expect(out[1].token_infos).toBe(input[1].token_infos);
    expect(input[1].network_infos.explorer_base_url).toBe("https://explorer.solana.com");
    expect(applySolscanToChains(out)).toBe(out);
  });
});

describe("app-owned Solscan URL builders", () => {
  it("builds tx and account links with optional devnet cluster", () => {
    expect(solscanTxUrl("sig")).toBe("https://solscan.io/tx/sig");
    expect(solscanTxUrl("sig", true)).toBe("https://solscan.io/tx/sig?cluster=devnet");
    expect(solscanAccountUrl("addr")).toBe("https://solscan.io/account/addr");
    expect(solscanAccountUrl("addr", true)).toBe("https://solscan.io/account/addr?cluster=devnet");
  });
});
