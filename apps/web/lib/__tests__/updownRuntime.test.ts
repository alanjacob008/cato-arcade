import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { UpdownConfigError, getUpdownRuntime, previewRefusal, sweepRefusal, updownConfig } from "../updownRuntime";
import { GET as sweepRoute } from "../../app/api/updown/sweep/route";

const mainnetPreview = { VITE_DEPLOYMENT_ENV: "mainnet", VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv;

describe("Up Down network setting on the server", () => {
  it("reads VITE_DEPLOYMENT_ENV like the game bundle does", () => {
    expect(updownConfig({ VITE_DEPLOYMENT_ENV: " Mainnet " } as unknown as NodeJS.ProcessEnv)).toMatchObject({ network: "mainnet", orderlyBase: "https://api.orderly.org" });
    expect(updownConfig({ VITE_DEPLOYMENT_ENV: "TESTNET" } as unknown as NodeJS.ProcessEnv)).toMatchObject({ network: "testnet", orderlyBase: "https://testnet-api.orderly.org" });
    expect(updownConfig({} as unknown as NodeJS.ProcessEnv).network).toBe("testnet");
  });

  it("refuses an unknown value with a config error instead of guessing", () => {
    for (const value of ["prod", "production", "main", "staging"]) {
      expect(() => updownConfig({ VITE_DEPLOYMENT_ENV: value } as unknown as NodeJS.ProcessEnv)).toThrow(UpdownConfigError);
      expect(() => updownConfig({ VITE_DEPLOYMENT_ENV: value } as unknown as NodeJS.ProcessEnv)).toThrow('must be "mainnet" or "testnet"');
    }
  });
});

describe("preview deployments and production secrets", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("refuses mainnet play on a non-production Vercel deployment unless explicitly allowed", () => {
    expect(previewRefusal(mainnetPreview)).toContain("does not play on mainnet from a preview deployment");
    expect(previewRefusal({ ...mainnetPreview, VERCEL_ENV: "development" } as unknown as NodeJS.ProcessEnv)).toContain("development");
    expect(previewRefusal({ ...mainnetPreview, UPDOWN_ALLOW_PREVIEW_MAINNET: "1" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(previewRefusal({ ...mainnetPreview, VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(previewRefusal({ VITE_DEPLOYMENT_ENV: "mainnet" } as unknown as NodeJS.ProcessEnv)).toBeNull(); // not on Vercel
    expect(previewRefusal({ VITE_DEPLOYMENT_ENV: "testnet", VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv)).toBeNull();
  });

  it("does not even start the runtime (no database connection) for mainnet on a preview", async () => {
    const env = { ...mainnetPreview, DATABASE_URL: "postgres://nobody@127.0.0.1:1/none", UPDOWN_JOURNAL_KEY: "a".repeat(64) } as unknown as NodeJS.ProcessEnv;
    await expect(getUpdownRuntime(env)).rejects.toThrow("does not play on mainnet");
  });

  it("refuses the sweep on any non-production deployment unless allowed", async () => {
    expect(sweepRefusal({ VERCEL_ENV: "preview" } as unknown as NodeJS.ProcessEnv)).toContain("only runs on the Production deployment");
    expect(sweepRefusal({ VERCEL_ENV: "preview", UPDOWN_ALLOW_PREVIEW_MAINNET: "1" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    expect(sweepRefusal({ VERCEL_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toBeNull();
    vi.stubEnv("CRON_SECRET", "s3cret");
    vi.stubEnv("DATABASE_URL", "postgres://nobody@127.0.0.1:1/none");
    vi.stubEnv("VERCEL_ENV", "preview");
    const res = await sweepRoute(new NextRequest("https://cato.example/api/updown/sweep", { headers: { authorization: "Bearer s3cret" } }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("only runs on the Production deployment");
  });
});
