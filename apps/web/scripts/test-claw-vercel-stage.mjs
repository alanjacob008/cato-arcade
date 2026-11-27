import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { stageClawBackend } from "./lib/claw-vercel-stage.mjs";

// The Vercel container project is uploaded from this folder, so it must hold exactly what the image needs and no private state.
// Runs on a clean checkout (CI): the verified build is git-ignored, so the test supplies fixture artifacts
// and skips the manifest check that prepare-claw-image.mjs performs on the real build.
const target = await mkdtemp(join(tmpdir(), "claw-stage-#-")), artifacts = await mkdtemp(join(tmpdir(), "claw-artifacts-"));
for (const name of ["claw_vrf_probe.so", "program-id.txt", "cluster.txt"]) await writeFile(join(artifacts, name), "fixture");
let prepared = 0;
const options = { artifacts, prepare: () => { prepared++; } };
async function walk(directory) {
  const out = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await walk(path)); else out.push(relative(target, path).replaceAll("\\", "/"));
  }
  return out;
}
try {
  await stageClawBackend(target, options);
  const files = await walk(target);
  for (const needed of ["Dockerfile", "deploy/claw-backend/package.json", "deploy/claw-backend/package-lock.json", "apps/web/scripts/vrf-er-server.mjs",
    "apps/web/scripts/lib/claw-session-store.mjs", "apps/web/scripts/lib/claw-sponsorship-worker.mjs", "apps/web/components/claw/rewards.ts", "apps/web/onchain/deployment.devnet.json", "apps/web/onchain/sponsorship.devnet.json",
    "deploy/claw-backend/artifacts/claw_vrf_probe.so", "deploy/claw-backend/artifacts/program-id.txt"])
    assert(files.includes(needed), `missing ${needed}`);
  for (const file of files)
    assert(!/(^|\/)(\.env|\.vercel\/)|onchain\/keys|signing-session|\.sqlite|keypair\.json|\.pem$|(^|\/)test-[^/]*\.mjs$/.test(file), `must not stage ${file}`);
  const docker = await readFile(join(target, "Dockerfile"), "utf8");
  assert(!/^VOLUME/m.test(docker), "Vercel has no persistent volume; signer state goes to Postgres");
  assert(/^ENV CLAW_REQUIRE_STATE_KEY=1$/m.test(docker), "without a disk, a missing state key must stop startup");
  assert(/^USER node$/m.test(docker) && /CMD \["node", "apps\/web\/scripts\/vrf-er-server.mjs"\]/.test(docker));
  // Region: next to the claw's Postgres (measured ~95 ms per query from iad1 on Nov 24; Neon cato-db is in Europe).
  // Every player request runs several sequential queries, so database distance dominates hosted latency.
  assert.deepEqual(JSON.parse(await readFile(join(target, "vercel.json"), "utf8")).regions, ["fra1"]);
  // Uploads exclude env files (vercel link writes a token into .env.local) and the project link.
  assert(files.includes(".vercelignore"));
  const ignored = (await readFile(join(target, ".vercelignore"), "utf8")).split(/\r?\n/);
  assert(ignored.includes(".env*") && ignored.includes(".vercel"));
  // Staging again replaces the folder rather than accumulating stale files, but keeps the Vercel project link.
  await mkdir(join(target, ".vercel"), { recursive: true });
  await writeFile(join(target, ".vercel/project.json"), "{}");
  await writeFile(join(target, "stale.txt"), "old");
  await stageClawBackend(target, options);
  assert(existsSync(join(target, ".vercel/project.json")), "restaging must keep the project link");
  assert.deepEqual((await walk(target)).filter(file => !file.startsWith(".vercel/")).sort(), files.sort());
  assert(!existsSync(join(target, "apps/web/onchain/keys")));
  assert.equal(prepared, 2, "the artifact check runs before every stage");
  // A failing artifact check stops staging with its reason, before anything is copied.
  await rm(target, { recursive: true, force: true });
  await assert.rejects(stageClawBackend(target, { artifacts, prepare: () => { throw Error("cashier_image_binary_mismatch"); } }), /cashier_image_binary_mismatch/);
  assert(!existsSync(join(target, "Dockerfile")));
} finally { await rm(target, { recursive: true, force: true }); await rm(artifacts, { recursive: true, force: true }); }
console.log("PASS: Vercel backend stage holds the image inputs and verified build only, with no keys, env files, ledgers or tests.");
