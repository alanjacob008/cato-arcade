import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {clawRuntimeConfig} from "./lib/claw-runtime-config.mjs";
import {postgresStore} from "./lib/claw-postgres.mjs";
import {POOL_SIZE,POOL_POLICY} from "./lib/vrf-er-pool.mjs";

const root=process.cwd(),local=clawRuntimeConfig({},root);
assert.equal(local.bind,"127.0.0.1");assert.equal(local.port,4322);assert.equal(local.playerOrigin,"http://127.0.0.1:4322");
const env={CLAW_HOSTED:"1",CLAW_SERVICE_ORIGIN:"https://api.example",CLAW_PUBLIC_ORIGIN:"https://arcade.example",CLAW_DATABASE_URL:"postgresql://test:test@db.example/cato?sslmode=verify-full",VRF_LOCAL_SESSION_TOKEN:"a".repeat(64),CLAW_STATE_DIR:"/data/claw-devnet",PORT:"8080"};
const host=clawRuntimeConfig(env,root);assert.equal(host.expectedHost,"api.example");assert.equal(host.bind,"0.0.0.0");assert.equal(host.playerOrigin,"https://arcade.example");assert.equal(host.port,8080);
for(const bad of ["http://api.example","https://api.example/extra","https://user:pass@api.example","https://api.example?key=value","https://api.example#fragment"])
  assert.throws(()=>clawRuntimeConfig({...env,CLAW_SERVICE_ORIGIN:bad},root));
assert.throws(()=>clawRuntimeConfig({...env,CLAW_DATABASE_URL:""},root),/claw_database_required/);
assert.throws(()=>clawRuntimeConfig({...env,VRF_LOCAL_SESSION_TOKEN:""},root),/hosted_admin_capability_required/);
assert.throws(()=>clawRuntimeConfig({...env,CLAW_STATE_DIR:"public/private"},root),/invalid_claw_state_directory/);
assert.throws(()=>clawRuntimeConfig({...env,PORT:"80"},root),/invalid_claw_port/);
// Vercel: the database URL can come from another variable (the Neon integration sets DATABASE_URL_UNPOOLED, sensitive),
// and signer state goes to Postgres when CLAW_STATE_KEY is set, so no persistent disk is needed.
const neon="postgresql://u:p@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require";
const viaEnv=clawRuntimeConfig({...env,CLAW_DATABASE_URL:"",CLAW_DATABASE_URL_ENV:"DATABASE_URL_UNPOOLED",DATABASE_URL_UNPOOLED:neon},root);
assert.equal(viaEnv.databaseUrl,neon);assert.equal(viaEnv.stateKey,null);
assert.throws(()=>clawRuntimeConfig({...env,CLAW_DATABASE_URL:"",CLAW_DATABASE_URL_ENV:"DATABASE_URL_UNPOOLED"},root),/claw_database_required/);
assert.throws(()=>clawRuntimeConfig({...env,CLAW_DATABASE_URL_ENV:"NEXT_PUBLIC_X"},root),/invalid_claw_database_url_env/);
assert.equal(clawRuntimeConfig({...env,CLAW_STATE_KEY:"b".repeat(64)},root).stateKey,"b".repeat(64));
assert.throws(()=>clawRuntimeConfig({...env,CLAW_STATE_KEY:"short"},root),/invalid_claw_state_key/);
// Hosts without a persistent disk set CLAW_REQUIRE_STATE_KEY=1: a missing key must stop startup, not silently create new signers.
assert.throws(()=>clawRuntimeConfig({...env,CLAW_REQUIRE_STATE_KEY:"1"},root),/claw_state_key_required/);
assert.equal(clawRuntimeConfig({...env,CLAW_REQUIRE_STATE_KEY:"1",CLAW_STATE_KEY:"b".repeat(64)},root).stateKey,"b".repeat(64));
assert.throws(()=>clawRuntimeConfig({CLAW_STATE_KEY:"b".repeat(64)},root),/claw_database_required/);
assert.equal(local.stateKey,null);
assert.throws(()=>postgresStore("postgresql://test:test@db.example/cato?sslmode=disable"),/claw_database_tls_required/);
assert.equal(POOL_POLICY.batchRequests,500);assert.equal(POOL_SIZE,8);assert.equal(POOL_POLICY.dailyLimit*POOL_SIZE,8000);assert.equal(POOL_POLICY.totalLimit*POOL_SIZE,56000);
assert.equal(POOL_POLICY.totalLimit,POOL_POLICY.dailyLimit*POOL_POLICY.lifetimeSeconds/86400,"Seven-day daily capacity must fit the lifetime grant");
const docker=await readFile(new URL("../../../deploy/claw-backend/Dockerfile",import.meta.url),"utf8"),ignore=await readFile(new URL("../../../.dockerignore",import.meta.url),"utf8");
assert(docker.includes("USER node"));assert(!/COPY\s+\.\s/.test(docker),"Never copy the whole workspace into the signer image");
assert(ignore.includes("**/onchain/keys")&&ignore.includes("**/onchain/artifacts")&&ignore.includes("**/.env.*"));
const lock=JSON.parse(await readFile(new URL("../../../deploy/claw-backend/package-lock.json",import.meta.url),"utf8"));
assert(lock.packages["node_modules/typescript"]);assert(!lock.packages["node_modules/next"]);assert(!lock.packages["node_modules/@solana/wallet-adapter-wallets"]);
console.log("PASS: exact hosted/local origins, private persistent-state paths, required Postgres/admin secret, database TLS, configured eight-lane 8,000/day and seven-day quota bounds, and isolated non-root backend packaging without wallet bundles or private state.");
