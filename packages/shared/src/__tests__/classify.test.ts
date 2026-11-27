import { describe, it, expect } from "vitest";
import { classifyCatoTx, type ParsedTx } from "../classify.js";
import { CATO_MINT } from "../constants.js";

const OWNER = "ownerWallet";
const DISTRIBUTOR = "airdropDistributor";

function tx(partial: Partial<ParsedTx> & { signature: string; timestamp: number }): ParsedTx {
  return partial;
}

describe("classifyCatoTx", () => {
  it("classifies a swap-in as a buy", () => {
    const c = classifyCatoTx(
      tx({
        signature: "s1",
        timestamp: 1_700_000_000,
        type: "SWAP",
        source: "RAYDIUM",
        tokenTransfers: [{ toUserAccount: OWNER, mint: CATO_MINT, tokenAmount: 500 }],
      }),
      { owner: OWNER },
    );
    expect(c?.kind).toBe("buy");
    expect(c?.amount).toBe(500);
  });

  it("classifies a swap-out as a sell", () => {
    const c = classifyCatoTx(
      tx({
        signature: "s2",
        timestamp: 1_700_000_100,
        source: "ORCA",
        tokenTransfers: [{ fromUserAccount: OWNER, mint: CATO_MINT, tokenAmount: 200 }],
      }),
      { owner: OWNER },
    );
    expect(c?.kind).toBe("sell");
  });

  it("classifies a plain transfer from a known distributor as an airdrop", () => {
    const c = classifyCatoTx(
      tx({
        signature: "s3",
        timestamp: 1_620_000_000,
        type: "TRANSFER",
        source: "SYSTEM_PROGRAM",
        tokenTransfers: [{ fromUserAccount: DISTRIBUTOR, toUserAccount: OWNER, mint: CATO_MINT, tokenAmount: 19417 }],
      }),
      { owner: OWNER, distributors: new Set([DISTRIBUTOR]) },
    );
    expect(c?.kind).toBe("airdrop_in");
    expect(c?.counterparty).toBe(DISTRIBUTOR);
  });

  it("classifies a plain transfer from an unknown sender as transfer_in", () => {
    const c = classifyCatoTx(
      tx({
        signature: "s4",
        timestamp: 1_620_000_500,
        type: "TRANSFER",
        tokenTransfers: [{ fromUserAccount: "someFriend", toUserAccount: OWNER, mint: CATO_MINT, tokenAmount: 10 }],
      }),
      { owner: OWNER, distributors: new Set([DISTRIBUTOR]) },
    );
    expect(c?.kind).toBe("transfer_in");
  });

  it("classifies a plain transfer out as transfer_out", () => {
    const c = classifyCatoTx(
      tx({
        signature: "s5",
        timestamp: 1_620_000_900,
        type: "TRANSFER",
        tokenTransfers: [{ fromUserAccount: OWNER, toUserAccount: "friend", mint: CATO_MINT, tokenAmount: 5 }],
      }),
      { owner: OWNER },
    );
    expect(c?.kind).toBe("transfer_out");
  });

  it("ignores transactions with no CATO movement for the owner", () => {
    const c = classifyCatoTx(
      tx({
        signature: "s6",
        timestamp: 1_620_001_000,
        tokenTransfers: [{ fromUserAccount: "a", toUserAccount: "b", mint: "OTHER_MINT", tokenAmount: 1 }],
      }),
      { owner: OWNER },
    );
    expect(c).toBeNull();
  });
});
