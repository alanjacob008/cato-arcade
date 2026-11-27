import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DEVNET_GENESIS, devnetEndpoint, readDevnetPreflight } from "./lib/vrf-devnet.mjs";

const manifest = JSON.parse(await readFile(new URL("../onchain/deployment.devnet.json", import.meta.url), "utf8"));
// The network-validation tests do not require a downloaded build artifact.
manifest.verifiedArtifact ??= { bytes: 177600 };
const programSource = (await readFile(new URL("../onchain/programs/claw-vrf-probe/src/lib.rs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
assert(programSource.includes(`declare_id!("${manifest.vrfProbeProgram}")`));
assert(programSource.includes(`#[cfg(feature = "devnet")]\npub const ADMIN: Pubkey = pubkey!("${manifest.adminAuthority}")`));
assert.equal(manifest.adminAuthority, manifest.deploymentAuthority);
assert.deepEqual(manifest.buildFeatures, ["devnet"]);
const mainnet = JSON.parse(await readFile(new URL("../onchain/deployment.mainnet.json", import.meta.url), "utf8"));
assert.notEqual(manifest.adminAuthority, mainnet.adminAuthority);
assert(programSource.includes(`#[cfg(not(feature = "devnet"))]\npub const ADMIN: Pubkey = pubkey!("${mainnet.adminAuthority}")`));
const loader = "BPFLoaderUpgradeab1e11111111111111111111111";
const accounts = [{ executable: true, owner: loader }, { executable: false, owner: manifest.vrfProgram }, null];
function mock({ genesis = DEVNET_GENESIS, mutate = value => value } = {}) {
  let calls = 0;
  const fetcher = async (_url, options) => {
    calls++;
    assert.equal(options.redirect, "error");
    const request = JSON.parse(options.body);
    if (!Array.isArray(request)) return Response.json({ id: 0, result: genesis });
    assert.deepEqual(request.map(item => item.method), ["getBalance", "getMultipleAccounts",
      ...Array(4).fill("getMinimumBalanceForRentExemption")]);
    const results = [{ value: 0 }, { value: structuredClone(accounts) }, 100, 200, 190, 10];
    return Response.json(mutate(results.map((result, id) => ({ jsonrpc: "2.0", id, result }))));
  };
  return { fetcher, calls: () => calls };
}
const happy = mock({ mutate: batch => batch.reverse() });
const result = await readDevnetPreflight(manifest, undefined, happy.fetcher);
assert.equal(result.cluster, "devnet");
assert.equal(result.testWallet, manifest.adminAuthority);
assert.equal(result.testWalletLamports, 0);
assert.equal(result.initialDeploymentRentShortfallLamports, 300);
assert.equal(result.consumerExecutable, false);
assert.equal(result.fulfilledCallbackObserved, false);
assert.equal(happy.calls(), 2);
for (const endpoint of ["https://mainnet.helius-rpc.com/?api-key=private", "http://api.devnet.solana.com",
  "https://attacker.example", "https://api.devnet.solana.com@attacker.example", "https://api.devnet.solana.com:444",
  "https://api.devnet.solana.com/path", "https://api.devnet.solana.com/#secret"]) {
  const test = mock();
  await assert.rejects(readDevnetPreflight(manifest, endpoint, test.fetcher), { message: "invalid_devnet_endpoint" });
  assert.equal(test.calls(), 0);
}
for (const genesis of ["5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d", "unknown"]) {
  const test = mock({ genesis });
  await assert.rejects(readDevnetPreflight(manifest, undefined, test.fetcher), { message: "devnet_genesis_mismatch" });
  assert.equal(test.calls(), 1);
}
for (const mutate of [batch => batch.slice(1), batch => [batch[0], ...batch.slice(0, -1)],
  batch => { batch[2].error = { message: "secret" }; return batch; },
  batch => { batch[0].result.value = -1; return batch; },
  batch => { batch[2].result = Number.MAX_SAFE_INTEGER + 1; return batch; },
  batch => { batch[2].result = Number.MAX_SAFE_INTEGER; return batch; }]) {
  await assert.rejects(readDevnetPreflight(manifest, undefined, mock({ mutate }).fetcher), { message: "invalid_devnet_response" });
}
await assert.rejects(readDevnetPreflight(manifest, undefined, mock({ mutate: batch => {
  batch[1].result.value[1].owner = loader; return batch;
} }).fetcher), { message: "devnet_oracle_unavailable" });
await assert.rejects(readDevnetPreflight(manifest, undefined, mock({ mutate: batch => {
  batch[1].result.value[2] = { executable: false, owner: loader }; return batch;
} }).fetcher), { message: "unexpected_consumer_account" });
const deployed = await readDevnetPreflight(manifest, undefined, mock({ mutate: batch => {
  batch[1].result.value[2] = { executable: true, owner: loader }; return batch;
} }).fetcher);
assert.equal(deployed.consumerExecutable, true);
assert.equal(deployed.initialDeploymentRentShortfallLamports, null);
assert.equal(deployed.fulfilledCallbackObserved, false);
await assert.rejects(readDevnetPreflight(manifest, "https://devnet.helius-rpc.com/?api-key=private",
  async () => { throw Error("https://devnet.helius-rpc.com/?api-key=private"); }), { message: "devnet_rpc_unavailable" });
// An empty HELIUS_DEVNET_RPC_URL (as in .env.example) means the public devnet fallback, same as unset.
assert.equal(devnetEndpoint("").href, "https://api.devnet.solana.com/");
assert.equal(devnetEndpoint(undefined).href, "https://api.devnet.solana.com/");
assert.throws(() => devnetEndpoint("https://api.mainnet-beta.solana.com"), /invalid_devnet_endpoint/);
console.log("PASS: devnet-only genesis/endpoint checks, read-only RPC, rent sizing, oracle ownership, malformed-response rejection and credential redaction.");
