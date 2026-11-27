import { API_URLS, type URLS } from "@orderly.network/core";
import type { NetworkId } from "@orderly.network/types";
import { parseDeploymentNetwork } from "./deployment-network.mjs";

export type DeploymentEnv = "qa" | "staging" | "prod";

const QA_URLS: URLS = {
  apiBaseUrl: "https://api.qa.orderly-i.network",
  publicWsUrl: "wss://ws.qa.orderly-i.network",
  privateWsUrl: "wss://ws-private.qa.orderly-i.network",
  operatorUrl: {
    EVM: "https://operator.qa.orderly-i.network",
    SOL: "https://sol-operator.qa.orderly-i.network",
  },
};

const STAGING_URLS = API_URLS.testnet;
const PROD_URLS = API_URLS.mainnet;

/**
 * VITE_DEPLOYMENT_ENV for the Orderly SDK, via the same parser as the round
 * service (deployment-network.mjs): "mainnet" -> prod, "testnet" or unset ->
 * staging (testnet). Any other value throws, as it fails the build, instead of
 * quietly meaning mainnet. ("qa" endpoints stay available through
 * getEnvironmentUrls for SDK tests, but no deployment can select them.)
 */
export function normalizeDeploymentEnv(value: unknown): DeploymentEnv {
  return parseDeploymentNetwork(value) === "mainnet" ? "prod" : "staging";
}

export function getDeploymentNetworkId(env: DeploymentEnv): NetworkId {
  return env === "prod" ? "mainnet" : "testnet";
}

export function getEnvironmentUrls(
  env: DeploymentEnv,
  networkId: NetworkId,
): URLS {
  if (networkId === "mainnet") return PROD_URLS;
  return env === "qa" ? QA_URLS : STAGING_URLS;
}

export function getDeploymentApiBaseUrl(value: unknown): string {
  const env = normalizeDeploymentEnv(value);
  const networkId = getDeploymentNetworkId(env);
  return getEnvironmentUrls(env, networkId).apiBaseUrl;
}
