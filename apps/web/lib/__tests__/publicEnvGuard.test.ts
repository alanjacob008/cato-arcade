import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoPublicSecrets, looksKeyed, publicDotenvValues, publicSecretVariables } from "../publicEnvGuard.mjs";

describe("public env guard", () => {
  it("flags browser-exposed variables that carry an API key, without echoing the value", () => {
    const env = {
      NEXT_PUBLIC_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=secret-value",
      VITE_SOLANA_RPC_URL: "https://rpc.example/?foo=1&apikey=secret-value",
      STAKE_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=server-only",
      NEXT_PUBLIC_SITE_URL: "https://www.ogcato.com",
    };
    expect(publicSecretVariables(env)).toEqual(["NEXT_PUBLIC_RPC_URL", "VITE_SOLANA_RPC_URL"]);
    expect(() => assertNoPublicSecrets(env)).toThrow(/NEXT_PUBLIC_RPC_URL, VITE_SOLANA_RPC_URL/);
    expect(() => assertNoPublicSecrets(env)).not.toThrow(/secret-value/);
  });

  it("recognises path-embedded provider tokens, userinfo, generic token parameters and encoded forms", () => {
    for (const value of [
      "https://example.solana-mainnet.quiknode.pro/0123456789abcdef0123456789abcdef/",
      "https://cato.rpcpool.com/0123456789abcdef-01234567",
      "https://solana-mainnet.g.alchemy.com/v2/abcdefghijklmnop",
      "https://rpc.ankr.com/solana/0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "https://user:pass@rpc.example.com",
      "https://rpc.example.com/?token=abc",
      "https://rpc.example.com/?key=abc",
      "https://rpc.example.com/?api%2Dkey=abc",
    ]) {
      expect(looksKeyed(value), value).toBe(true);
    }
    for (const value of ["https://api.mainnet-beta.solana.com", "https://www.ogcato.com", "/updown/", "mainnet", "{\"a\":1}"]) {
      expect(looksKeyed(value), value).toBe(false);
    }
  });

  it("flags public variables named as credentials, but not public IDs", () => {
    expect(publicSecretVariables({ NEXT_PUBLIC_HELIUS_API_KEY: "x", VITE_SOME_SECRET: "y" })).toEqual([
      "NEXT_PUBLIC_HELIUS_API_KEY",
      "VITE_SOME_SECRET",
    ]);
    expect(
      publicSecretVariables({ VITE_WALLETCONNECT_PROJECT_ID: "abc", VITE_PRIVY_APP_ID: "def", NEXT_PUBLIC_HELIUS_API_KEY: "" }),
    ).toEqual([]);
  });

  it("allows keyless public endpoints and server-only keys", () => {
    expect(() => assertNoPublicSecrets({
      NEXT_PUBLIC_RPC_URL: "https://api.devnet.solana.com",
      HELIUS_API_KEY: "server-only",
      STAKE_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=server-only",
    })).not.toThrow();
  });

  it("reads public values from the dotenv files a bundler loads itself", () => {
    const dir = mkdtempSync(join(tmpdir(), "env-guard-"));
    try {
      writeFileSync(join(dir, ".env"), "# comment\nVITE_SOLANA_RPC_URL=\"https://mainnet.helius-rpc.com/?api-key=k\"\nSERVER_ONLY=1\n");
      writeFileSync(join(dir, ".env.local"), "export VITE_OTHER=plain\r\n");
      const values = publicDotenvValues(dir);
      expect(Object.keys(values).sort()).toEqual(["VITE_OTHER", "VITE_SOLANA_RPC_URL"]);
      expect(publicSecretVariables(values)).toEqual(["VITE_SOLANA_RPC_URL"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
