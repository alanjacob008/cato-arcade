// Devnet-only admin for the local claw backend, using a key file instead of the Phantom dashboard.
//   CLAW_ADMIN_KEYPAIR=<path to key file> VRF_LOCAL_SESSION_TOKEN=<64 hex> [CLAW_ADMIN_ORIGIN=https://backend] node scripts/devnet-admin-cli.mjs state | deploy | lane <0-7>
// Prints public keys and plan descriptions only. The key file never leaves this process.
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import { Keypair } from "@solana/web3.js";
import { adminPolicy, adminSpend, adminTarget, signPlan } from "./lib/devnet-admin-sign.mjs";
import { POOL_SIZE } from "./lib/vrf-er-pool.mjs";

// Same env files as the backend (apps/web/.env.local), so both share one admin capability.
nextEnv.loadEnvConfig(fileURLToPath(new URL("..", import.meta.url)), false, { info() {}, error() {} });

const [command, argument] = process.argv.slice(2);
// Local backend by default; CLAW_ADMIN_ORIGIN=https://... for the hosted one.
const { origin, host } = adminTarget(process.env), target = new URL(origin), request = target.protocol === "https:" ? httpsRequest : httpRequest;
const token = process.env.VRF_LOCAL_SESSION_TOKEN ?? "";
if (!/^[a-f0-9]{64}$/.test(token)) throw Error("Set VRF_LOCAL_SESSION_TOKEN to the backend's 64-hex admin capability.");
if (!process.env.CLAW_ADMIN_KEYPAIR) throw Error("Set CLAW_ADMIN_KEYPAIR to the admin wallet key file path.");
const keypair = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(await readFile(process.env.CLAW_ADMIN_KEYPAIR, "utf8"))));
// Only instructions this manifest's plans use are signed (see adminPolicy); the backend's "devnet" label is not enough.
const policy = adminPolicy(JSON.parse(await readFile(new URL("../onchain/deployment.devnet.json", import.meta.url), "utf8")));
console.log(`Admin ${keypair.publicKey.toBase58()} → backend ${origin}`);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function api(path, body) {
  const payload = body === undefined ? null : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request({ host: target.hostname, port: target.port || undefined, path: `/api/${path}`, method: payload ? "POST" : "GET", timeout: 180000,
      headers: { Host: host, Authorization: `Bearer ${token}`, ...(payload ? { Origin: origin, "Content-Type": "application/json" } : {}) } }, res => {
      let text = ""; res.setEncoding("utf8"); res.on("data", chunk => { text += chunk; });
      res.on("end", () => { try { const data = JSON.parse(text); res.statusCode === 200 ? resolve(data) : reject(Error(data.error ?? `http_${res.statusCode}`)); } catch { reject(Error(`http_${res.statusCode}`)); } });
    });
    req.on("timeout", () => req.destroy(Error("admin_request_timeout"))); req.on("error", reject); req.end(payload);
  });
}

// Requests plans until the backend reports done; signs and submits each one. The SOL caps
// apply to everything signed in this run, so a backend cannot split a drain across plans.
const spent = adminSpend();
async function drive(next, label) {
  for (let step = 0; step < 300; step++) {
    const plan = await next(step);
    if (plan.done) { console.log(`${label}: done.`); return; }
    if (plan.waiting) { console.log(`${label}: ${plan.description}`); await wait(3000); continue; }
    console.log(`${label}: signing "${plan.description}"`);
    const result = await api("submit", { id: plan.id, transactions: signPlan(plan, keypair, policy, spent) });
    console.log(`${label}: confirmed ${(result.signatures ?? []).join(", ") || "submission"}`);
    await wait(1500);
  }
  throw Error(`${label}: step limit reached; run the same command again to resume.`);
}

const state = await api("state");
if (state.authority !== keypair.publicKey.toBase58()) throw Error(`Key file is ${keypair.publicKey.toBase58()}, backend authority is ${state.authority}.`);
if (command === "state") {
  const { attempts, transactions, ...summary } = state;
  console.log(JSON.stringify({ ...summary, attempts: attempts?.length, transactions: transactions?.length }, null, 2));
} else if (command === "performance") {
  console.log(JSON.stringify(await api("performance"),null,2));
} else if (command === "deploy") {
  await drive(step => api("deploy", { resume: step === 0 }), "deploy");
} else if (command === "lane" && /^(0|[1-9]\d*)$/.test(argument ?? "") && Number(argument) < POOL_SIZE) {
  await drive(() => api("pool/plan", { lane: Number(argument) }), `lane ${argument}`);
} else {
  throw Error(`Usage: devnet-admin-cli.mjs state | performance | deploy | lane <0-${POOL_SIZE-1}>`);
}
