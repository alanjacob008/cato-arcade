import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Every place that pins the devnet program or its admin must agree with the manifest,
// and none may still name the retired program/authority from before 2026-11-24.
const read = path => readFile(new URL(path, import.meta.url), "utf8").then(text => text.replaceAll("\r\n", "\n"));
const manifest = JSON.parse(await read("../onchain/deployment.devnet.json"));
const mainnet = JSON.parse(await read("../onchain/deployment.mainnet.json"));
const lib = await read("../onchain/programs/claw-vrf-probe/src/lib.rs");
const workflow = await read("../../../.github/workflows/claw-vrf-build.yml");
const diagnostic = await read("../server/rpc-diagnostic.ts");
const walletApp = await read("./devnet-wallet/app.js");

assert.equal(manifest.adminAuthority, "EWFPbtH2Zeopd8ffK9W4L2UbxxY5ppFpwUgbybF6S7Lv");
assert.equal(manifest.deploymentAuthority, manifest.adminAuthority);
assert.equal(manifest.upgradeFrom, undefined);
assert(lib.includes(`declare_id!("${manifest.vrfProbeProgram}");`));
assert(workflow.includes(`'${manifest.vrfProbeProgram}' > artifacts/program-id.txt`));
assert(workflow.includes(`'${manifest.adminAuthority}' > artifacts/admin-authority.txt`));
assert(diagnostic.includes(`const PROBE_PROGRAM = "${manifest.vrfProbeProgram}"`));
assert.equal(mainnet.vrfProbeProgram, manifest.vrfProbeProgram);
for (const [name, file] of Object.entries({ lib, workflow, diagnostic, walletApp }))
  for (const old of ["EcCoQQxdqTKbwcc9tXq8ah4JVjDHbCEZyvxQMxqXct9k", "SamyzLYUBP6hSHYJwwrUt8nV2zqY2jFSK61x68Uhbq2", "Samyz…Hbq2"])
    assert(!file.includes(old), `${name} still names ${old}`);
console.log("PASS: devnet program and admin identities agree across contract, workflow, manifests and tools.");
