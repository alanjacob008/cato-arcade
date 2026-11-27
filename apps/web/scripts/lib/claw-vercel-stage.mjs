import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve, dirname, sep } from "node:path";

// Builds the upload folder for the separate Vercel container project that runs the claw backend.
// It mirrors the repo paths the Dockerfile copies, plus the verified build, and nothing else.
const repo = new URL("../../../../", import.meta.url), web = new URL("apps/web/", repo);
const skip = path => /(^|[\\/])(test-[^\\/]*\.mjs|node_modules|\.env[^\\/]*)$/.test(path);

// prepare-claw-image.mjs checks the verified build against the manifest and copies it to deploy/claw-backend/artifacts/.
const prepareImage = () => execFileSync(process.execPath, [fileURLToPath(new URL("scripts/prepare-claw-image.mjs", web))], { stdio: ["ignore", "ignore", "inherit"] });

export async function stageClawBackend(target, { prepare = prepareImage, artifacts = fileURLToPath(new URL("deploy/claw-backend/artifacts/", repo)) } = {}) {
  // The verified artifacts are checked against the manifest before anything is staged.
  await prepare();
  const targetRoot=resolve(target);
  if(dirname(targetRoot)===targetRoot)throw Error("invalid_claw_stage_root");
  const into = path => {
    const destination=resolve(targetRoot,path);
    if(destination!==targetRoot&&!destination.startsWith(targetRoot+sep))throw Error("claw_stage_path_escape");
    // Escape # and % in native paths; string-built file URLs can otherwise target a parent directory.
    return pathToFileURL(destination+(path===""||path.endsWith("/")?sep:""));
  };
  // Start clean, but keep the Vercel project link (.vercel/) so restaging does not unlink the project.
  await mkdir(into(""), { recursive: true });
  for (const entry of await readdir(into(""))) if (entry !== ".vercel") await rm(into(entry), { recursive: true, force: true });
  // vercel link writes a token into .env.local; never upload env files or the link itself.
  await writeFile(into(".vercelignore"), [".env*", ".vercel", ""].join("\n"));
  await mkdir(into("apps/web/onchain/"), { recursive: true });
  await cp(new URL("scripts/", web), into("apps/web/scripts/"), { recursive: true, filter: source => !skip(source) });
  await cp(new URL("components/claw/", web), into("apps/web/components/claw/"), { recursive: true });
  await cp(new URL("onchain/deployment.devnet.json", web), into("apps/web/onchain/deployment.devnet.json"));
  await cp(new URL("onchain/sponsorship.devnet.json", web), into("apps/web/onchain/sponsorship.devnet.json"));
  // Region for the container project (Vercel reads vercel.json at the upload root): next to the claw database.
  await cp(new URL("deploy/claw-backend/vercel.json", repo), into("vercel.json"));
  for (const name of ["package.json", "package-lock.json"]) await cp(new URL(`deploy/claw-backend/${name}`, repo), into(`deploy/claw-backend/${name}`));
  await cp(artifacts, into("deploy/claw-backend/artifacts/"), { recursive: true });
  // Same image as deploy/claw-backend/Dockerfile, without the volume: on Vercel the signer state is sealed into Postgres.
  const docker = (await readFile(new URL("deploy/claw-backend/Dockerfile", repo), "utf8")).replace(/^VOLUME .*\r?\n/m, "ENV CLAW_REQUIRE_STATE_KEY=1\n");
  await writeFile(into("Dockerfile"), docker);
}
