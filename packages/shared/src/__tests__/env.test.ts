import { describe, it, expect } from "vitest";
import { loadEnv, heliusRpcUrl, heliusDevnetRpcUrl } from "../env.js";
import { CATO_MINT, ORIGINAL_AIRDROP_AMOUNT } from "../constants.js";

const base = {
  HELIUS_API_KEY: "test-key",
  DATABASE_URL: "postgres://localhost:5432/test",
};

describe("loadEnv", () => {
  it("throws a clear error when HELIUS_API_KEY is missing", () => {
    expect(() => loadEnv({ DATABASE_URL: base.DATABASE_URL } as NodeJS.ProcessEnv)).toThrow(
      /HELIUS_API_KEY/,
    );
  });

  it("throws a clear error when DATABASE_URL is missing", () => {
    expect(() => loadEnv({ HELIUS_API_KEY: base.HELIUS_API_KEY } as NodeJS.ProcessEnv)).toThrow(
      /DATABASE_URL/,
    );
  });

  it("applies defaults for optional values", () => {
    const env = loadEnv(base as NodeJS.ProcessEnv);
    expect(env.catoMint).toBe(CATO_MINT);
    expect(env.gateThreshold).toBe(ORIGINAL_AIRDROP_AMOUNT);
    expect(env.broadScanMaxPages).toBe(10);
    expect(env.priceSource).toBe("jupiter");
    expect(env.apiPort).toBe(8080);
  });

  it("honors an overridden gate threshold", () => {
    const env = loadEnv({ ...base, GATE_THRESHOLD: "1000" } as NodeJS.ProcessEnv);
    expect(env.gateThreshold).toBe(1000);
  });

  it("rejects a non-numeric threshold", () => {
    expect(() => loadEnv({ ...base, GATE_THRESHOLD: "lots" } as NodeJS.ProcessEnv)).toThrow(
      /GATE_THRESHOLD/,
    );
  });

  it("builds the Helius RPC URL from the key", () => {
    expect(heliusRpcUrl("abc")).toBe("https://mainnet.helius-rpc.com/?api-key=abc");
  });

  it("builds the Helius devnet RPC URL from the key", () => {
    expect(heliusDevnetRpcUrl("abc")).toBe("https://devnet.helius-rpc.com/?api-key=abc");
  });
});
