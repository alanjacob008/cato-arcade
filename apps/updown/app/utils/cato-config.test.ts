import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CustomConfigStore,
  normalizeDeploymentEnv,
  getDeploymentNetworkId,
} from "./orderly-environment";
import { getRuntimeConfig } from "./runtime-config";
import { resolveDexThemeConfig } from "./theme-config";

afterEach(() => {
  delete window.__RUNTIME_CONFIG__;
  vi.unstubAllEnvs();
});

describe("Cato deployment configuration", () => {
  it("routes a fresh checkout to testnet, even if a previous app saved mainnet", () => {
    vi.stubEnv("VITE_DEPLOYMENT_ENV", "");
    vi.stubEnv("VITE_ORDERLY_BROKER_ID", "");
    vi.stubEnv("VITE_DISABLE_MAINNET", "");
    localStorage.setItem("orderly_network_id", "mainnet");
    const env = normalizeDeploymentEnv(getRuntimeConfig("VITE_DEPLOYMENT_ENV"));
    const store = new CustomConfigStore({
      brokerId: getRuntimeConfig("VITE_ORDERLY_BROKER_ID")!,
      env,
      networkId: getDeploymentNetworkId(env),
    });
    expect(store.get("networkId")).toBe("testnet");
    expect(store.get("apiBaseUrl")).toBe("https://testnet-api.orderly.org");
    expect(getRuntimeConfig("VITE_DISABLE_MAINNET")).toBe("true");
    localStorage.removeItem("orderly_network_id");
  });

  it("validates and uses the Cato theme rather than silently falling back to Orderly purple", () => {
    const resolved = resolveDexThemeConfig();
    expect(resolved.source).toBe("theme-config");
    expect(resolved.themes[0].displayName).toBe("Cato Dark");
    expect(resolved.themes[0].tradingViewColorConfig?.chartBG).toBe("#161616");
  });

  it("allows the registered broker to be supplied at build time", () => {
    vi.stubEnv("VITE_ORDERLY_BROKER_ID", "cato_test");
    expect(getRuntimeConfig("VITE_ORDERLY_BROKER_ID")).toBe("cato_test");
  });
});
