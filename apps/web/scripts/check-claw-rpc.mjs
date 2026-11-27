import nextEnv from "@next/env";

// Quietly load server-only local configuration; never log URLs or provider errors.
nextEnv.loadEnvConfig(process.cwd(), true, { info() {}, error() {} });

async function check(label, value) {
  if (!value) { console.error(`${label}: configuration missing.`); return false; }
  try {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:" || !["mainnet.helius-rpc.com", "beta.helius-rpc.com"].includes(endpoint.hostname)) {
      console.error(`${label}: unexpected endpoint. Use the mainnet HTTPS URL from Helius.`);
      return false;
    }
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion", params: [] }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) {
      console.error(`${label}: HTTP ${response.status}. Check the key and public-IP allowlist.`);
      return false;
    }
    const data = await response.json();
    if (data.error || !data.result || typeof data.result["solana-core"] !== "string") {
      console.error(`${label}: RPC rejected the read-only version request.`);
      return false;
    }
    console.log(`${label}: connected. No signing or transactions performed.`);
    return true;
  } catch {
    console.error(`${label}: connection failed. Check network access and the allowlist.`);
    return false;
  }
}

const mainnet = await check("Helius mainnet", process.env.HELIUS_RPC_URL);
const gatekeeper = process.env.HELIUS_GATEKEEPER_RPC_URL
  ? await check("Helius Gatekeeper", process.env.HELIUS_GATEKEEPER_RPC_URL) : true;
if (!mainnet || !gatekeeper) process.exitCode = 1;
