import { describe, expect, it } from "vitest";
import { parseDeploymentNetwork, validateGameNetworkEnv } from "./deployment-network.mjs";

describe("VITE_DEPLOYMENT_ENV (shared by the bundle, the build and the round service)", () => {
  it.each([
    ["mainnet", "mainnet"],
    [" Mainnet\n", "mainnet"],
    ["testnet", "testnet"],
    ["TESTNET", "testnet"],
    ["", "testnet"],
    [undefined, "testnet"],
  ])("reads %j as %s", (value, network) => {
    expect(parseDeploymentNetwork(value)).toBe(network);
  });

  it.each(["prod", "production", "staging", "qa", "main", "mainnet2"])("refuses %j", (value) => {
    expect(() => parseDeploymentNetwork(value)).toThrow('VITE_DEPLOYMENT_ENV must be "mainnet" or "testnet"');
  });

  it("fails a mainnet build whose page could still switch to testnet", () => {
    expect(validateGameNetworkEnv({ VITE_DEPLOYMENT_ENV: "testnet" })).toBe("testnet");
    expect(() => validateGameNetworkEnv({ VITE_DEPLOYMENT_ENV: "mainnet" })).toThrow("VITE_DISABLE_MAINNET=false");
    expect(() => validateGameNetworkEnv({ VITE_DEPLOYMENT_ENV: "mainnet", VITE_DISABLE_MAINNET: "false" })).toThrow("VITE_DISABLE_TESTNET=true");
    expect(validateGameNetworkEnv({ VITE_DEPLOYMENT_ENV: "mainnet", VITE_DISABLE_MAINNET: "false", VITE_DISABLE_TESTNET: "true" })).toBe("mainnet");
    expect(() => validateGameNetworkEnv({ VITE_DEPLOYMENT_ENV: "prod" })).toThrow("must be");
  });
});
