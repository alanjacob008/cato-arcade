// Local, read-only diagnostics. Never imported by the application or its RPC routes.
export const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const LOADER = "BPFLoaderUpgradeab1e11111111111111111111111";

export function devnetEndpoint(value) {
  // Unset or empty (as in .env.example) both mean the public devnet fallback.
  const url = new URL(value || "https://api.devnet.solana.com");
  if (url.protocol !== "https:" || url.username || url.password || url.port
    || url.pathname !== "/" || url.hash
    || !["api.devnet.solana.com", "devnet.helius-rpc.com"].includes(url.hostname)) {
    throw new Error("invalid_devnet_endpoint");
  }
  return url;
}

function validLamports(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export async function readDevnetPreflight(manifest, endpoint, fetcher = fetch) {
  // Keep error messages fixed: provider URLs, keys and raw errors must never escape.
  let url;
  try { url = devnetEndpoint(endpoint); }
  catch { throw new Error("invalid_devnet_endpoint"); }
  if (manifest.cluster !== "devnet" || manifest.genesisHash !== DEVNET_GENESIS
    || !Number.isSafeInteger(manifest.verifiedArtifact?.bytes)
    || manifest.verifiedArtifact.bytes < 1 || manifest.verifiedArtifact.bytes > 1_048_576) {
    throw new Error("invalid_devnet_manifest");
  }
  async function rpc(payload) {
    let response;
    try {
      response = await fetcher(url, {
        method: "POST", headers: { "Content-Type": "application/json" },
        redirect: "error", signal: AbortSignal.timeout(15000),
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch { throw new Error("devnet_rpc_unavailable"); }
  }
  // Fail closed before reading balances/accounts from an incorrectly configured cluster.
  const genesis = await rpc({ jsonrpc: "2.0", id: 0, method: "getGenesisHash", params: [] });
  if (genesis?.id !== 0 || genesis.error || genesis.result !== DEVNET_GENESIS) {
    throw new Error("devnet_genesis_mismatch");
  }
  const bytes = manifest.verifiedArtifact.bytes;
  const requests = [
    { method: "getBalance", params: [manifest.adminAuthority, { commitment: "confirmed" }] },
    { method: "getMultipleAccounts", params: [[manifest.vrfProgram, manifest.vrfQueue, manifest.vrfProbeProgram],
      { commitment: "confirmed", encoding: "base64", dataSlice: { offset: 0, length: 0 } }] },
    ...[36, 45 + bytes, 37 + bytes, 117].map(size => ({ method: "getMinimumBalanceForRentExemption", params: [size] })),
  ].map((request, id) => ({ jsonrpc: "2.0", id, ...request }));
  const batch = await rpc(requests);
  if (!Array.isArray(batch) || batch.length !== requests.length) throw new Error("invalid_devnet_response");
  const results = new Map();
  for (const entry of batch) {
    if (!entry || !Number.isInteger(entry.id) || entry.id < 0 || entry.id >= requests.length
      || results.has(entry.id) || entry.error || !("result" in entry)) throw new Error("invalid_devnet_response");
    results.set(entry.id, entry.result);
  }
  const balance = results.get(0)?.value;
  const accounts = results.get(1)?.value;
  const rents = [2, 3, 4, 5].map(id => results.get(id));
  if (!validLamports(balance) || !Array.isArray(accounts) || accounts.length !== 3
    || !rents.every(value => validLamports(value) && value > 0)) throw new Error("invalid_devnet_response");
  const [vrf, queue, consumer] = accounts;
  if (vrf?.executable !== true || vrf.owner !== LOADER || !queue || queue.owner !== manifest.vrfProgram
    || queue.executable !== false) throw new Error("devnet_oracle_unavailable");
  if (consumer && (consumer.executable !== true || consumer.owner !== LOADER)) throw new Error("unexpected_consumer_account");
  const [program, programData, buffer, attempt] = rents;
  const deploymentRent = program + Math.max(programData, buffer);
  if (!Number.isSafeInteger(deploymentRent)) throw new Error("invalid_devnet_response");
  return {
    cluster: "devnet", genesisHash: DEVNET_GENESIS, testWallet: manifest.adminAuthority,
    testWalletLamports: balance, vrfProgramExecutable: true, queueOwnedByVrf: true,
    consumerProgram: manifest.vrfProbeProgram, consumerExecutable: consumer?.executable === true,
    binaryBytes: bytes, rentLamports: { program, programData, buffer, attempt },
    // Loader v3 reuses staging rent during an initial deployment; refresh before signing.
    initialDeploymentRentLamports: deploymentRent,
    initialDeploymentRentShortfallLamports: consumer ? null : Math.max(0, deploymentRent - balance),
    transactionAndOracleFeesIncluded: false,
    fulfilledCallbackObserved: false,
  };
}
