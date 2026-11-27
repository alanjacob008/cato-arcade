import { describe, expect, it } from "vitest";
import { getDeploymentApiBaseUrl } from "./orderly-urls";

describe("build API environment", () => {
  it.each([
    ["testnet", "https://testnet-api.orderly.org"],
    [" TestNet ", "https://testnet-api.orderly.org"],
    ["mainnet", "https://api.orderly.org"],
    [" MAINNET ", "https://api.orderly.org"],
    [undefined, "https://testnet-api.orderly.org"],
    ["", "https://testnet-api.orderly.org"],
  ])("maps %s to %s", (env, expected) => {
    expect(getDeploymentApiBaseUrl(env)).toBe(expected);
  });

  it.each(["prod", "production", "main", "staging", "qa", "mainnet-beta"])("refuses %s instead of guessing a network", (env) => {
    expect(() => getDeploymentApiBaseUrl(env)).toThrow('must be "mainnet" or "testnet"');
  });
});
