import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readDevnetPreflight } from "./lib/vrf-devnet.mjs";

try {
  const manifest = JSON.parse(await readFile(new URL("../onchain/deployment.devnet.json", import.meta.url), "utf8"));
  if (!manifest.verifiedArtifact) throw new Error("devnet_artifact_not_built");
  // A missing/changed binary stops the check. Do not quote rent for an unrelated build.
  const ready = new URL("../onchain/artifacts/devnet/ready/", import.meta.url);
  const binary = await readFile(new URL("claw_vrf_probe.so", ready));
  if (binary.length !== manifest.verifiedArtifact.bytes
    || createHash("sha256").update(binary).digest("hex") !== manifest.verifiedArtifact.sha256
    || (await readFile(new URL("source-commit.txt", ready), "utf8")).trim() !== manifest.verifiedArtifact.sourceCommit
    || (await readFile(new URL("cluster.txt", ready), "utf8")).trim() !== "devnet"
    || (await readFile(new URL("admin-authority.txt", ready), "utf8")).trim() !== manifest.adminAuthority
    || (await readFile(new URL("program-id.txt", ready), "utf8")).trim() !== manifest.vrfProbeProgram) {
    throw new Error("artifact_checksum_mismatch");
  }
  const report = await readDevnetPreflight(manifest, process.env.HELIUS_DEVNET_RPC_URL);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), artifactChecksumVerified: true, ...report }, null, 2));
  if (!report.consumerExecutable) process.exitCode = 2;
} catch (error) {
  const known = new Set(["devnet_artifact_not_built", "artifact_checksum_mismatch", "invalid_devnet_endpoint", "invalid_devnet_manifest",
    "devnet_rpc_unavailable", "devnet_genesis_mismatch", "invalid_devnet_response",
    "devnet_oracle_unavailable", "unexpected_consumer_account"]);
  console.error(known.has(error.message) ? error.message : "devnet_preflight_failed_check_local_artifact");
  process.exitCode = 1;
}
