import { createServer } from "node:http";
import { request as localRequest } from "node:http";
import { readFile, mkdir } from "node:fs/promises";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import nextEnv from "@next/env";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, VersionedTransaction, NONCE_ACCOUNT_LENGTH } from "@solana/web3.js";
import { DEVNET_GENESIS, devnetEndpoint } from "./lib/vrf-devnet.mjs";
import { pacedRpcFetch, singleFlightCache, safeRpcError } from "./lib/vrf-rpc-transport.mjs";
import { createGameService, loadClawRules } from "./lib/vrf-game.mjs";
import { createSponsoredSender } from "./lib/vrf-sponsor.mjs";
import { createAttemptReader } from "./lib/vrf-callbacks.mjs";
import { createVrfNotifications } from "./lib/vrf-notifications.mjs";
import { createDeploymentVerifier, createRollupDeploymentVerifier } from "./lib/vrf-program.mjs";
import { createClawLedger } from "./lib/claw-ledger.mjs";
import { createLedgerPhysics } from "./lib/claw-ledger-physics.mjs";
import { createPlayerApi } from "./lib/claw-player-api.mjs";
import { createErPoolRuntime } from "./lib/vrf-er-pool-runtime.mjs";
import { clawRuntimeConfig } from "./lib/claw-runtime-config.mjs";
import { acquireCoordinatorWithin, postgresStore } from "./lib/claw-postgres.mjs";
import { createSaveQueue, fileSessionStore, pgSessionStore } from "./lib/claw-session-store.mjs";
import { createPgClawLedger } from "./lib/claw-pg-ledger.mjs";
import { createCashierChain, cashierAddresses, initializeCashierInstruction, decodeCashier } from "./lib/claw-cashier-chain.mjs";
import { createClawPayments } from "./lib/claw-payments.mjs";
import { createSponsorshipChain, sponsorshipFeeKey, SPONSOR_LANES } from "./lib/claw-sponsorship-chain.mjs";
import { POOL_SIZE } from "./lib/vrf-er-pool.mjs";
import { createSponsorshipWorker } from "./lib/claw-sponsorship-worker.mjs";
import { createClawLatencyProbe } from "./lib/claw-latency-probe.mjs";
import { ER_ENDPOINT, ER_FUNDING, DELEGATION_PROGRAM, erSessionPhase, erDelegationAddresses, initializeErSession,
  delegateErSession, undelegateErSession, requestErProbe, decodeErSession, decodeErAttempt, checkErDelegation, verifyErEndpoint } from "./lib/vrf-er.mjs";
import { LOADER, BATCH_SIZE, CHUNK_BYTES, initializeBuffer, writeBuffer, deployProgram, missingChunks,
  requestProbe, decodeAttempt, discriminator, u64, setBufferAuthority,
  walletTransaction, signedWalletTransaction, walletMessageDifference,
  readDurableNonce, durableTransaction, checkSigningLifetime, UPLOAD_FUNDING_LAMPORTS, matchesCallback } from "./lib/vrf-deployment.mjs";
import { nextProgramUpgrade, sponsorAddress, decodeSponsor, grantSponsor, revokeSponsor,
  requestSponsoredProbe, SPONSOR_REQUESTS, SPONSOR_SECONDS, SPONSOR_FUNDING } from "./lib/vrf-deployment.mjs";

const root = new URL("../", import.meta.url);
nextEnv.loadEnvConfig(fileURLToPath(root), false, { info() {}, error() {} });
if (process.env.CLAW_VRF_EXECUTION && process.env.CLAW_VRF_EXECUTION !== "er") throw Error("invalid_vrf_execution");
const er = process.env.CLAW_VRF_EXECUTION === "er";
const runtimeConfig = clawRuntimeConfig(process.env,fileURLToPath(root),er);
const {port,origin} = runtimeConfig;
const stateDirectory = runtimeConfig.stateDirectory;
await mkdir(stateDirectory,{recursive:true,mode:0o700});
const sqlStore = runtimeConfig.databaseUrl ? postgresStore(runtimeConfig.databaseUrl) : null;
const ready = new URL("onchain/artifacts/devnet/ready/", root);
const sessionFile = new URL(`${er ? "er-" : ""}signing-session.json`, stateDirectory);
const readJson = async path => JSON.parse(await readFile(path, "utf8"));
const manifest = await readJson(new URL("onchain/deployment.devnet.json", root));
const binary = await readFile(new URL("claw_vrf_probe.so", ready));
if (binary.length !== manifest.verifiedArtifact?.bytes || createHash("sha256").update(binary).digest("hex") !== manifest.verifiedArtifact.sha256
  || (await readFile(new URL("cluster.txt", ready), "utf8")).trim() !== "devnet"
  || (await readFile(new URL("admin-authority.txt", ready), "utf8")).trim() !== manifest.adminAuthority
  || (await readFile(new URL("program-id.txt", ready), "utf8")).trim() !== manifest.vrfProbeProgram) throw Error("artifact_mismatch");
const endpoint = devnetEndpoint(process.env.HELIUS_DEVNET_RPC_URL);
const httpHeaders = {};
if (process.env.DEVNET_RPC_ORIGIN) {
  const allowed = new URL(process.env.DEVNET_RPC_ORIGIN);
  if (allowed.protocol !== "https:" || allowed.pathname !== "/" || allowed.username || allowed.password || allowed.port || allowed.hash || allowed.search) throw Error("invalid_rpc_origin");
  httpHeaders.Origin = allowed.origin;
}
const connection = new Connection(endpoint.href, { commitment: "confirmed", httpHeaders,
  fetch: pacedRpcFetch(), disableRetryOnRateLimit: true });
const executionConnection = er ? new Connection(ER_ENDPOINT, { commitment: "confirmed", disableRetryOnRateLimit: true }) : connection;
const payer = new PublicKey(manifest.adminAuthority), program = new PublicKey(manifest.vrfProbeProgram);
// Hosted rollouts overlap old and new instances; wait (bounded) for the old one to release the lock instead of exiting.
if(sqlStore)await acquireCoordinatorWithin(sqlStore,program.toBase58(),()=>{console.error("Claw coordinator lease lost; stopping signer runtime.");process.exit(1);},{waitMs:runtimeConfig.hosted?90000:0});
// Validate the program-account signer before any buffer rent can be spent.
let programKey = null;
try { programKey = Keypair.fromSecretKey(Uint8Array.from(await readJson(new URL("onchain/keys/claw_vrf_probe-keypair.json", root)))); }
catch(error) { if(error.code !== "ENOENT") throw Error("invalid_program_signer"); }
if (programKey && !programKey.publicKey.equals(program)) throw Error("program_key_mismatch");
// Upgrading an existing program requires the wallet's upgrade authority, not
// its original program-account key. Missing keys never allow a new deployment.
if (!programKey) {
  if(await connection.getGenesisHash() !== DEVNET_GENESIS) throw Error("devnet_genesis_mismatch");
  const existingProgram = await connection.getAccountInfo(program);
  if(!existingProgram?.executable || !existingProgram.owner.equals(LOADER)) throw Error("program_signer_required_for_initial_deployment");
}
// Signer session: a local file, or a sealed Postgres row when CLAW_STATE_KEY is set (hosts without a persistent disk).
const sessionStore = runtimeConfig.stateKey ? await pgSessionStore(sqlStore, { program: program.toBase58(), key: runtimeConfig.stateKey })
  : fileSessionStore(sessionFile, stateDirectory);
let session = await sessionStore.load();
if (session && (session.program !== program.toBase58() || session.authority !== payer.toBase58()
  || session.sha256 !== manifest.verifiedArtifact.sha256 && session.sha256 !== manifest.upgradeFrom?.sha256)) throw Error("signing_session_mismatch");
if (session && session.sha256 !== manifest.verifiedArtifact.sha256) {
  session.previousSha256 = session.sha256; session.sha256 = manifest.verifiedArtifact.sha256;
  session.uploadPhase = null; session.uploadError = null;
}
session ??= { program: program.toBase58(), authority: payer.toBase58(), sha256: manifest.verifiedArtifact.sha256,
  bufferKey: Array.from(Keypair.generate().secretKey), attempts: [], transactions: [] };
const bufferKey = Keypair.fromSecretKey(Uint8Array.from(session.bufferKey));
session.uploadKey ??= Array.from(Keypair.generate().secretKey);
session.nonceAddress ??= process.env.VRF_DURABLE_NONCE?.trim() || undefined;
if (!session.nonceAddress) session.nonceKey ??= Array.from(Keypair.generate().secretKey);
session.sponsorKey ??= Array.from(Keypair.generate().secretKey);
session.cashierKey ??= Array.from(Keypair.generate().secretKey);
const uploadKey = Keypair.fromSecretKey(Uint8Array.from(session.uploadKey));
const nonceKey = session.nonceAddress ? { publicKey:new PublicKey(session.nonceAddress) } : Keypair.fromSecretKey(Uint8Array.from(session.nonceKey));
if(session.nonceAddress) { readDurableNonce(await connection.getAccountInfo(nonceKey.publicKey), payer); session.nonceReady = true; }
const sponsorKey = Keypair.fromSecretKey(Uint8Array.from(session.sponsorKey));
const cashierKey = Keypair.fromSecretKey(Uint8Array.from(session.cashierKey));
if([payer,sponsorKey.publicKey,uploadKey.publicKey].some(key=>key.equals(cashierKey.publicKey)))throw Error("cashier_signer_must_be_isolated");
// Snapshots written in call order; a failed write does not block later ones. If another instance has taken over
// the signer state (claw_state_superseded), stop: this process no longer holds the coordinator lock.
const enqueueSave = createSaveQueue(sessionStore, () => { console.error("Claw signer state superseded by another instance; stopping."); process.exit(1); });
const save = () => enqueueSave(session);
await save();
const token = /^[a-f0-9]{64}$/.test(process.env.VRF_LOCAL_SESSION_TOKEN ?? "") ? process.env.VRF_LOCAL_SESSION_TOKEN : randomBytes(32).toString("hex");
let issued = null, busy = false, uploadTask = null;
const clusterCache = singleFlightCache(async () => {
  if (await connection.getGenesisHash() !== DEVNET_GENESIS) throw Error("devnet_genesis_mismatch");
  return true;
}, 60000);
async function cluster() { await clusterCache.get(); }
try { await cluster(); } catch (error) { throw Error(safeRpcError(error)); }

const deployed = createDeploymentVerifier({ connection, program, authority: payer, binary, previous: manifest.upgradeFrom });
const erIdentity = singleFlightCache(verifyErEndpoint, 60000);
const erProgramVerified = er ? createRollupDeploymentVerifier({ connection: executionConnection, program, authority: payer, binary }) : null;
const latencyProbe=createClawLatencyProbe({database:sqlStore?()=>sqlStore.query("SELECT 1"):null,
  base:()=>connection.getSlot("confirmed"),rollup:er?()=>executionConnection.getSlot("confirmed"):null,
  attestBase:deployed,attestRollup:erProgramVerified,saveStats:()=>enqueueSave.stats(),region:process.env.VERCEL_REGION});
const cashierChain=createCashierChain({connection,manifest,key:cashierKey,verified:deployed});
const erDelegated = singleFlightCache(async () => {
  const p = erDelegationAddresses(manifest, sponsorKey.publicKey);
  const [record, root] = await connection.getMultipleAccountsInfo([p.record, p.session]);
  if (!root?.owner.equals(DELEGATION_PROGRAM)) throw Error("er_session_not_delegated");
  return checkErDelegation(record, manifest);
}, 15000);
async function erPermit() {
  const p = erDelegationAddresses(manifest, sponsorKey.publicKey);
  const [, , local] = await Promise.all([erIdentity.get(), erDelegated.get(), executionConnection.getAccountInfo(p.session)]);
  return decodeErSession(local, manifest, sponsorKey.publicKey);
}
async function erSponsorState() {
  const p = erDelegationAddresses(manifest, sponsorKey.publicKey);
  const [account, funds] = await connection.getMultipleAccountsInfo([p.session, sponsorKey.publicKey]);
  const base = { address: sponsorKey.publicKey.toBase58(), balanceSol: (funds?.lamports ?? 0) / 1e9, remaining: 0, expiresAt: null, ready: false };
  if (!account) return { ...base, phase: "initialize" };
  if (account.owner.equals(program)) {
    const state = decodeErSession(account, manifest, sponsorKey.publicKey);
    return { ...base, ...state, phase: erSessionPhase(state) };
  }
  if (!account.owner.equals(DELEGATION_PROGRAM)) throw Error("er_session_owner_mismatch");
  const state = await erPermit();
  return { ...base, ...state, phase: "delegated", ready: !!state && state.remaining > 0 && state.expiresAt > Date.now() / 1000 };
}
async function sponsorState() {
  if (er) return erSponsorState();
  const [permitAccount, funds] = await connection.getMultipleAccountsInfo([sponsorAddress(manifest, sponsorKey.publicKey)[0], sponsorKey.publicKey]);
  const permit = decodeSponsor(permitAccount, manifest, sponsorKey.publicKey);
  const balance = funds?.lamports ?? 0;
  return { address: sponsorKey.publicKey.toBase58(), balanceSol: balance / 1e9, remaining: permit?.remaining ?? 0,
    expiresAt: permit?.expiresAt ?? null, ready: !!permit && permit.remaining > 0 && permit.expiresAt > Date.now() / 1000 && balance >= 3_000_000 };
}
const callbackHints = new Map();
const refreshAttempt = createAttemptReader({ connection: executionConnection, manifest, save, hints: locked => callbackHints.get(locked.nonce) ?? [],
  ...(er ? { decode: decodeErAttempt, callback: (tx, config, locked, result) => matchesCallback(tx, config, locked, result, "consume_er_probe") } : {}) });
async function readState() {
  await cluster();
  const isDeployed = await deployed();
  let missing = null;
  if (!isDeployed) {
    const account = await connection.getAccountInfo(bufferKey.publicKey);
    if (account) {
      const authority = bufferAuthority(account);
      missing = missingChunks(account.data, binary, authority).length;
    }
  }
  const last = session.attempts.at(-1);
  if (last && isDeployed) await refreshAttempt(last);
  const sponsor = await sponsorState();
  // Warm code attestation during connect/status, before insertion starts.
  let rollupError = null;
  if (er && isDeployed && sponsor.ready) {
    try {if(!await erProgramVerified())rollupError="rollup_program_not_ready";}
    catch(error){rollupError=safeRpcError(error);}
  }
  return { cluster: "devnet", execution: er ? "er" : "base",hosted:runtimeConfig.hosted,playerOrigin:runtimeConfig.playerOrigin, authority: payer.toBase58(), program: program.toBase58(), buffer: bufferKey.publicKey.toBase58(),
    sha256: manifest.verifiedArtifact.sha256, bytes: binary.length, deployed: isDeployed,
    missingChunks: missing, totalChunks: Math.ceil(binary.length / CHUNK_BYTES), balanceSol: (await connection.getBalance(payer)) / 1e9,
    attempts: session.attempts.map(item => { const copy = { ...item }; delete copy.seed; delete copy.gamePull; delete copy.gameFingerprint; delete copy.sponsorWire; return copy; }),
    transactions: session.transactions, negativeChecks: session.negativeChecks ?? [], rpcProvider: er ? "MagicBlock Asia devnet ER" : endpoint.hostname === "devnet.helius-rpc.com" ? "Helius devnet" : "Public Solana devnet",
    uploading: !!uploadTask, uploadError: session.uploadError ?? null, uploadPhase: session.uploadPhase ?? null,
    uploadSigner: uploadKey.publicKey.toBase58(), nonceReady: !!session.nonceReady,
    lastSigningFailure: session.lastSigningFailure ?? null, sponsor, notifications: notifications.state(),
    sponsorship:topups?.status()??{enabled:false,ready:false},
    cashier:{...await cashierChain.status(),signer:cashierKey.publicKey.toBase58(),supported:!!manifest.verifiedArtifact.capabilities?.includes("devnet-cashier-v1")},
    ...(pool ? {pool:await pool.status(),poolSupported:!!manifest.verifiedArtifact.capabilities?.includes("bounded-er-pool-v1"),rollupError} : {}) };
}
const statusCache = singleFlightCache(readState, 5000);
const state = () => statusCache.get();
const playerStatus = singleFlightCache(async () => {
  await cluster();
  const [isDeployed, pooled] = await Promise.all([deployed(), er ? pool.status() : null]);
  const active = pooled?.enabled ? pooled : await sponsorState();
  if (er && isDeployed && active.ready && !await erProgramVerified()) throw Error("rollup_program_not_ready");
  return { cluster: "devnet", execution: er ? "er" : "base", authority: payer.toBase58(), deployed: isDeployed,
    sponsor: { ready: active.ready, remaining: active.remaining, expiresAt: pooled?.enabled ? null : active.expiresAt },
    ...(pooled?.enabled ? {pool:{size:pooled.size,occupied:pooled.occupied}} : {}) };
}, 5000);
const sendSponsored = createSponsoredSender({ connection: executionConnection, key: sponsorKey, manifest, save, refreshAttempt,
  ...(er ? { requestFactory: requestErProbe, permitState: erPermit } : {}) });
const game = createGameService({ session, rules: await loadClawRules(), manifest, prepare, refreshAttempt, save, deployed,
  ...(er ? { deployed: async () => await deployed() && await erProgramVerified(), nextNonce: async () => {
    const permit = await erPermit(); if (!permit || permit.pending) throw Error("er_session_pending_or_missing"); return permit.nextNonce;
  } } : {}),
  requestProbe: (config, ...args) => (er ? requestErProbe : requestSponsoredProbe)(config, sponsorKey.publicKey, ...args),
  requestAuthority: sponsorKey.publicKey.toBase58(), sendSponsored });
if(process.env.CLAW_ENABLE_SPONSOR_TOPUPS==="1"&&POOL_SIZE!==SPONSOR_LANES)throw Error("sponsorship_pool_size_upgrade_required");
const pool = er ? await createErPoolRuntime({session,manifest,save,connection,executionConnection,rules:await loadClawRules(),
  identity:()=>erIdentity.get(),deployed,verified:async()=>await deployed()&&await erProgramVerified(),
  legacy:{game,has:id=>session.attempts.some(attempt=>attempt.gamePull?.id===id)}}) : null;
let topups=null;
if(process.env.CLAW_ENABLE_SPONSOR_TOPUPS==="1"){
  if(!er)throw Error("sponsorship_requires_er_coordinator");
  const fundingManifest=await readJson(new URL("onchain/sponsorship.devnet.json",root));
  const owner=new PublicKey(process.env.CLAW_SPONSOR_VAULT_OWNER),feeKey=sponsorshipFeeKey(process.env);
  const recipients=session.poolLanes.map(lane=>Keypair.fromSecretKey(Uint8Array.from(lane.key)).publicKey.toBase58());
  if([payer,cashierKey.publicKey,uploadKey.publicKey,sponsorKey.publicKey,...recipients.map(key=>new PublicKey(key))].some(key=>key.equals(feeKey.publicKey)))throw Error("sponsorship_fee_wallet_must_be_isolated");
  if(owner.equals(feeKey.publicKey))throw Error("sponsorship_owner_and_keeper_must_differ");
  const binding=[fundingManifest.program,owner.toBase58(),feeKey.publicKey.toBase58(),...recipients].join(":");
  session.sponsorship??={binding};
  if(session.sponsorship.binding!==binding)throw Error("sponsorship_pending_configuration_mismatch");
  await save();
  topups=createSponsorshipWorker({chain:createSponsorshipChain({connection,manifest:fundingManifest,owner,feeKey,recipients}),store:session.sponsorship,save,
    onAlert:code=>console.error("Claw funding alert:",code)});
  const runTopups=()=>topups.tick().catch(()=>{});
  setInterval(runTopups,15000).unref();runTopups();
}
const ledgerPhysics = er ? createLedgerPhysics() : null;
// Sign-in challenge MAC key: derived (one-way) from the private admin capability, so a configured
// VRF_LOCAL_SESSION_TOKEN keeps in-flight challenges valid across a restart; otherwise per process.
const ledgerOptions={origin:runtimeConfig.playerOrigin,rules:await loadClawRules(),physics:ledgerPhysics,game:pool?.game,
  challengeKey:createHash("sha256").update("cato-claw-player-challenge-v1:"+token).digest(),
  available:async()=>{const state=await playerStatus.get();return state.deployed&&state.sponsor.ready;}};
const ledger = er ? sqlStore ? await createPgClawLedger({...ledgerOptions,store:sqlStore,paymentsEnabled:runtimeConfig.paymentsEnabled})
  : createClawLedger({...ledgerOptions,filename:fileURLToPath(new URL("player-ledger.sqlite",stateDirectory))}) : null;
const payments=er&&runtimeConfig.paymentsEnabled?createClawPayments({ledger,chain:cashierChain}):null;
const playerApi = er ? createPlayerApi({ledger,origin:runtimeConfig.playerOrigin,payments,availability:()=>playerStatus.get()}) : null;
let ledgerTick = false;
if(ledger) setInterval(async()=>{if(ledgerTick)return;ledgerTick=true;try{await ledger.tick();if(payments)await payments.tick();}catch{console.error("Claw reconciliation pending; original reservations retained.");}finally{ledgerTick=false;}},2000).unref();
const notifications = createVrfNotifications({ endpoint: er ? ER_ENDPOINT : endpoint.href, origin: er ? undefined : httpHeaders.Origin,
  handler: er ? "ConsumeErProbe" : "ConsumeProbe",
  program: program.toBase58(), onCallback: async hint => {
    const pending = session.attempts.filter(item => item.requestSignature && !item.callbackSignature);
    for (const locked of pending) {
      const prior = callbackHints.get(locked.nonce) ?? [];
      if (!prior.some(item => item.signature === hint.signature)) callbackHints.set(locked.nonce, [...prior, hint].slice(-3));
      await refreshAttempt(locked);
      // A poll already in flight can have read the earlier pending state.
      if (!locked.callbackSignature) await refreshAttempt(locked);
      if (locked.callbackSignature) callbackHints.delete(locked.nonce);
    }
    statusCache.invalidate();
  } });
if(pool) createVrfNotifications({endpoint:ER_ENDPOINT,handler:"ConsumeErPoolProbe",program:program.toBase58(),
  onCallback:async hint=>{await pool.notify(hint);statusCache.invalidate();playerStatus.invalidate();}});
async function prepare(instructions, signers = [], description, kind, locked = null, durable = false) {
  await cluster();
  if(durable&&!await connection.getAccountInfo(nonceKey.publicKey)){
    if(!nonceKey.secretKey)throw Error("configured_nonce_missing");
    const rent=await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
    return prepare([SystemProgram.createNonceAccount({fromPubkey:payer,noncePubkey:nonceKey.publicKey,authorizedPubkey:payer,lamports:rent}).instructions],
      [nonceKey],"Create an owner-controlled devnet durable nonce for subsequent setup approvals. Repeat the requested setup after this confirms.","nonce-setup",null,false);
  }
  if (durable && instructions.length !== 1) throw Error("durable_nonce_requires_single_transaction");
  const nonce = durable ? { account: nonceKey.publicKey, value: await currentNonce() } : null;
  const block = durable ? null : await connection.getLatestBlockhash();
  const txs = instructions.map(list => {
    const items = durable ? durableTransaction(payer, nonce.account, nonce.value, list).instructions : list;
    const tx = walletTransaction(payer, nonce?.value ?? block.blockhash, items, signers);
    if (tx.serialize().length > 1232) throw Error("transaction_too_large");
    return tx;
  });
  issued = { id: randomBytes(16).toString("hex"), txs, block, nonce, kind, locked };
  return { id: issued.id, kind, description, cluster: "devnet", authority: payer.toBase58(),
    lifetime: durable ? "durable-nonce" : "recent-blockhash",
    transactions: txs.map(tx => Buffer.from(tx.serialize()).toString("base64")) };
}
function bufferAuthority(account) {
  if (!account.owner.equals(LOADER) || account.data.length !== 37 + binary.length
    || account.data.readUInt32LE(0) !== 1 || account.data[4] !== 1) throw Error("unexpected_buffer");
  const authority = new PublicKey(account.data.subarray(5, 37));
  if (!authority.equals(payer) && !authority.equals(uploadKey.publicKey)) throw Error("unexpected_buffer_authority");
  return authority;
}
async function currentNonce() {
  const account = await connection.getAccountInfo(nonceKey.publicKey);
  if (!account) throw Error("nonce_not_initialized");
  return readDurableNonce(account, payer);
}
async function confirmSignatures(signatures, pollMs = 1000) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const statuses = (await connection.getSignatureStatuses(signatures, { searchTransactionHistory: true })).value;
    if (statuses.some(item => item?.err)) throw Error("devnet_transaction_failed");
    if (statuses.every(item => ["confirmed", "finalized"].includes(item?.confirmationStatus))) return;
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }
  throw Error("confirmation_pending_check_status_before_retry");
}
async function localTransactions(txs, kind) {
  const signatures = [];
  for (const tx of txs) {
    if (!tx.feePayer.equals(uploadKey.publicKey) || !tx.verifySignatures()) throw Error("invalid_local_upload_transaction");
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    signatures.push(signature); session.transactions.push({ signature, kind });
    statusCache.invalidate(); await save();
  }
  await confirmSignatures(signatures);
  statusCache.invalidate();
}
async function ensureNonce() {
  const existing = await connection.getAccountInfo(nonceKey.publicKey);
  if (existing) { readDurableNonce(existing, payer); session.nonceReady = true; return; }
  if (!nonceKey.secretKey) throw Error("recovered_nonce_account_missing");
  session.uploadPhase = "Preparing durable signing";
  const rent = await connection.getMinimumBalanceForRentExemption(NONCE_ACCOUNT_LENGTH);
  if (rent > 2_000_000) throw Error("nonce_rent_exceeds_upload_budget");
  const block = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: uploadKey.publicKey, ...block }).add(...SystemProgram.createNonceAccount({
    fromPubkey: uploadKey.publicKey, noncePubkey: nonceKey.publicKey, authorizedPubkey: payer, lamports: rent }).instructions);
  tx.sign(uploadKey, nonceKey);
  await localTransactions([tx], "nonce"); await currentNonce(); session.nonceReady = true; await save();
}
async function returnUploadFunds() {
  const balance = await connection.getBalance(uploadKey.publicKey);
  if (balance <= 5000) return;
  const block = await connection.getLatestBlockhash();
  const make = lamports => new Transaction({ feePayer: uploadKey.publicKey, ...block }).add(SystemProgram.transfer({ fromPubkey: uploadKey.publicKey, toPubkey: payer, lamports }));
  const fee = (await connection.getFeeForMessage(make(1).compileMessage())).value;
  if (!Number.isSafeInteger(fee) || fee < 0) throw Error("upload_refund_fee_unavailable");
  if (balance <= fee) return;
  const tx = make(balance - fee); tx.sign(uploadKey);
  await localTransactions([tx], "upload-refund");
}
function startUpload() {
  if (uploadTask) return;
  session.uploadError = null;
  uploadTask = (async () => {
    await cluster();
    for (let batch = 0; batch < 100; batch++) {
      const account = await connection.getAccountInfo(bufferKey.publicKey);
      if (!account) throw Error("upload_buffer_missing");
      const authority = bufferAuthority(account), missing = missingChunks(account.data, binary, authority);
      if (!missing.length) break;
      if (!authority.equals(uploadKey.publicKey)) throw Error("upload_authorization_required");
      session.uploadPhase = `Uploading ${missing.length} remaining chunks automatically`;
      const block = await connection.getLatestBlockhash();
      const txs = missing.slice(0, BATCH_SIZE).map(chunk => {
        const tx = new Transaction({ feePayer: uploadKey.publicKey, ...block }).add(writeBuffer(bufferKey.publicKey, uploadKey.publicKey, chunk.offset, chunk.bytes));
        tx.sign(uploadKey); return tx;
      });
      await localTransactions(txs, "write");
    }
    let account = await connection.getAccountInfo(bufferKey.publicKey);
    if (!account || missingChunks(account.data, binary, bufferAuthority(account)).length) throw Error("upload_incomplete");
    await ensureNonce();
    if (bufferAuthority(account).equals(uploadKey.publicKey)) {
      session.uploadPhase = "Returning buffer control to Phantom";
      const tx = new Transaction({ feePayer: uploadKey.publicKey, ...await connection.getLatestBlockhash() })
        .add(setBufferAuthority(bufferKey.publicKey, uploadKey.publicKey, payer));
      tx.sign(uploadKey); await localTransactions([tx], "restore-buffer-authority");
    }
    account = await connection.getAccountInfo(bufferKey.publicKey);
    if (!bufferAuthority(account).equals(payer)) throw Error("buffer_authority_not_restored");
    await returnUploadFunds();
    session.uploadPhase = "Ready for final deployment approval";
  })().catch(async error => {
    session.uploadError = safeRpcError(error);
    if (error.logs) console.error("Devnet upload program logs:", error.logs.slice(-12));
    await save();
  }).finally(async () => { uploadTask = null; statusCache.invalidate(); await save(); });
  void uploadTask.catch(() => console.error("upload_session_save_failed"));
}
async function planDeploy(body = {}) {
  await cluster();
  if (await deployed()) return { done: true };
  if (body.resume === true) session.uploadError = null;
  if (session.uploadError) throw Error(session.uploadError);
  if (uploadTask) return { waiting: true, description: session.uploadPhase ?? "Uploading automatically" };
  const account = await connection.getAccountInfo(bufferKey.publicKey);
  if (!account) {
    const rent = await connection.getMinimumBalanceForRentExemption(37 + binary.length);
    let storage=0;const existing=await connection.getAccountInfo(program);
    if(existing){
      if(!existing.owner.equals(LOADER)||existing.data.readUInt32LE(0)!==2)throw Error("unexpected_program_account");
      const metadata=await connection.getAccountInfo(new PublicKey(existing.data.subarray(4)));
      if(!metadata?.owner.equals(LOADER)||metadata.data.readUInt32LE(0)!==3||metadata.data[12]!==1||!metadata.data.subarray(13,45).equals(payer.toBuffer()))throw Error("unexpected_programdata_account");
      const extra=Math.max(0,binary.length-(metadata.data.length-45)),allocation=Math.ceil(extra/10240)*10240;
      storage=Math.max(0,await connection.getMinimumBalanceForRentExemption(metadata.data.length+allocation)-metadata.lamports);
    }
    if ((await connection.getBalance(payer)) < rent + storage + UPLOAD_FUNDING_LAMPORTS + 1_000_000) throw Error("insufficient_devnet_sol_for_upgrade_peak");
    return prepare([[SystemProgram.transfer({ fromPubkey: payer, toPubkey: uploadKey.publicKey, lamports: UPLOAD_FUNDING_LAMPORTS }),
      SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: bufferKey.publicKey,
        lamports: rent, space: 37 + binary.length, programId: LOADER }), initializeBuffer(bufferKey.publicKey, uploadKey.publicKey)]],
    [bufferKey], `Create the buffer with ${(rent / 1e9).toFixed(6)} devnet SOL rent and authorize the local uploader with ${(UPLOAD_FUNDING_LAMPORTS / 1e9).toFixed(3)} devnet SOL for fees and nonce rent.`, "uploader");
  }
  if ((await connection.getBalance(payer)) < 5_000_000) throw Error("insufficient_devnet_sol_for_remaining_fees");
  const authority = bufferAuthority(account), missing = missingChunks(account.data, binary, authority);
  const uploadBalance = await connection.getBalance(uploadKey.publicKey);
  const hasNonce = await connection.getAccountInfo(nonceKey.publicKey);
  if (missing.length || authority.equals(uploadKey.publicKey) || !hasNonce || uploadBalance > 5000) {
    if (authority.equals(uploadKey.publicKey) || (!missing.length && ((hasNonce && uploadBalance > 5000) || uploadBalance >= 2_100_000))) {
      startUpload(); return { waiting: true, description: "Continuing the authorized local upload" };
    }
    const funding = Math.max(0, UPLOAD_FUNDING_LAMPORTS - uploadBalance);
    const instructions = [];
    if (funding) instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: uploadKey.publicKey, lamports: funding }));
    if (missing.length) instructions.push(setBufferAuthority(bufferKey.publicKey, payer, uploadKey.publicKey));
    return prepare([instructions], [], `Authorize a local key to manage this buffer and fund it with ${(funding / 1e9).toFixed(6)} devnet SOL for upload fees and durable-nonce rent. Unused upload funds return to your wallet. Program upgrade authority stays with you.`, "uploader");
  }
  // Only this non-wallet program-account key signs locally. The Phantom private key never leaves Phantom.
  const existing = await connection.getAccountInfo(program);
  if (existing) {
    const data = await connection.getAccountInfo(PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0]);
    if (!data) throw Error("programdata_missing");
    const step = await nextProgramUpgrade({ connection, authority: payer, program, buffer: bufferKey.publicKey, bytes: binary.length, account: data });
    const description = step.kind === "extend"
      ? "Expand program storage using devnet SOL rent. This approval only expands storage; a separate approval will upgrade the uploaded binary afterward."
      : "Upgrade the verified devnet consumer. Program upgrade authority stays with your Phantom wallet. Temporary buffer rent returns to you; the larger ProgramData allocation retains its additional rent.";
    return prepare([[step.instruction]], [], description, step.kind, null, true);
  }
  if (!programKey) throw Error("program_signer_required_for_initial_deployment");
  const rent = await connection.getMinimumBalanceForRentExemption(36);
  return prepare([[ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: program, lamports: rent, space: 36, programId: LOADER }),
    deployProgram(payer, program, bufferKey.publicKey, binary.length)]], [programKey],
    "Deploy verified binary using a durable nonce. Upgrade authority stays with your Phantom address; buffer rent is reused.", "deploy", null, true);
}
async function planSponsor(revoke = false) {
  await cluster(); if (!await deployed()) throw Error("sponsored_program_upgrade_required");
  if (er) return planErSponsor(revoke);
  const state = await sponsorState();
  if (!revoke && state.ready) return { done: true };
  const instructions = [];
  if (revoke) {
    if (!state.expiresAt) throw Error("sponsor_not_initialized");
    instructions.push(revokeSponsor(manifest, sponsorKey.publicKey));
  } else {
    const funding = Math.max(0, SPONSOR_FUNDING - Math.round(state.balanceSol * 1e9));
    if (funding) instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: sponsorKey.publicKey, lamports: funding }));
    instructions.push(grantSponsor(manifest, sponsorKey.publicKey, Math.floor(Date.now() / 1000) + SPONSOR_SECONDS, !!state.expiresAt));
  }
  return prepare([instructions], [], revoke ? "Revoke the sponsor: block new requests while allowing already-requested callbacks to finish."
    : `Authorize ${SPONSOR_REQUESTS} devnet VRF requests for 6 hours and top up the separate sponsor wallet to 0.05 devnet SOL. No treasury, upgrade or withdrawal authority is granted.`,
  revoke ? "sponsor-revoke" : "sponsor-grant", null, true);
}
async function planErSponsor(revoke) {
  const state = await erSponsorState();
  if (revoke) {
    if (state.phase !== "delegated" || state.pending) throw Error("er_session_not_ready_to_return");
    const block = await executionConnection.getLatestBlockhash();
    const tx = walletTransaction(sponsorKey.publicKey, block.blockhash, [undelegateErSession(manifest, sponsorKey.publicKey)], [sponsorKey]);
    const signature = await executionConnection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
    session.transactions.push({ signature, kind: "er-undelegate", execution: "er" }); await save();
    return { done: true, description: "Session return requested. Refresh until it is back on Solana devnet before renewing." };
  }
  if (state.ready) return { done: true };
  if (state.phase === "delegated") throw Error("return_er_session_before_renewal");
  await erIdentity.get();
  const instructions = [];
  if (state.phase === "initialize" || state.phase === "renew") {
    const funding = Math.max(0, ER_FUNDING - Math.round(state.balanceSol * 1e9));
    if (funding) instructions.push(SystemProgram.transfer({ fromPubkey: payer, toPubkey: sponsorKey.publicKey, lamports: funding }));
    instructions.push(initializeErSession(manifest, sponsorKey.publicKey, Math.floor(Date.now() / 1000) + SPONSOR_SECONDS, state.phase === "renew"));
  } else instructions.push(delegateErSession(manifest, sponsorKey.publicKey));
  return prepare([instructions], [], state.phase === "delegate"
    ? "Delegate only this isolated diagnostic session to the pinned MagicBlock Asia devnet validator. Treasury and upgrade authority remain with Phantom."
    : "Initialize or renew 500 diagnostic requests for 6 hours and top up a separate test signer to 0.005 devnet SOL. A second approval delegates this session to the rollup.",
  `er-${state.phase}`, null, true);
}
async function planProbe(body) {
  if (er) throw Error("use_er_claw_timing_test");
  await cluster();
  if (!await deployed()) throw Error("program_not_deployed");
  let locked = session.attempts.at(-1);
  if (locked) {
    await refreshAttempt(locked);
    if (!locked.callbackSignature && locked.result?.status !== "not_submitted") throw Error("previous_callback_pending_check_status");
  }
  if (!locked || locked.callbackSignature) {
    if (![64, 128].includes(body.count) || !["0", "2147483648", "4294967296"].includes(body.threshold)) throw Error("invalid_probe");
    const nonce = randomBytes(8).readBigUInt64LE().toString(), seed = randomBytes(32);
    const request = requestProbe(manifest, nonce, body.count, 0, body.threshold, seed);
    locked = { nonce, count: body.count, target: 0, threshold: body.threshold, seed: seed.toString("hex"),
      attempt: request.attempt.toBase58(), bump: request.bump };
    session.attempts.push(locked);
    await save();
  }
  const request = requestProbe(manifest, locked.nonce, locked.count, locked.target, locked.threshold, Buffer.from(locked.seed, "hex"));
  return prepare([[request.instruction]], [], `${locked.count} boxes, ${Number(locked.threshold) / 2 ** 32 * 100}% diagnostic threshold; one locked request.`, "probe", locked, true);
}
async function submit(body) {
  await cluster();
  const plan = issued;
  if (!plan || body.id !== plan.id || !Array.isArray(body.transactions) || body.transactions.length !== plan.txs.length) throw Error("stale_signing_plan");
  const txs = [];
  for (const [index, value] of body.transactions.entries()) {
    if (typeof value !== "string" || value.length > 1800) throw Error("invalid_signed_transaction");
    const bytes = Buffer.from(value, "base64");
    try { txs.push(signedWalletTransaction(bytes, plan.txs[index])); }
    catch (error) {
      session.lastSigningFailure = { at: new Date().toISOString(), kind: plan.kind,
        error: safeRpcError(error), ...walletMessageDifference(bytes, plan.txs[index]) };
      await save(); statusCache.invalidate(); throw error;
    }
  }
  checkSigningLifetime(plan, plan.nonce ? await currentNonce() : null, plan.nonce ? null : await connection.getBlockHeight());
  const signatures = [];
  // Bound concurrency to reduce public-devnet RPC throttling.
  for (let i = 0; i < txs.length; i += 2) {
    const sent = await Promise.all(txs.slice(i, i + 2).map(tx => connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 })));
    signatures.push(...sent);
    session.transactions.push(...sent.map(signature => ({ signature, kind: plan.kind })));
    if (plan.locked) { plan.locked.requestSignature = sent[0]; plan.locked.submittedAt = Date.now(); }
    statusCache.invalidate();
    await save();
  }
  await confirmSignatures(signatures);
  if (plan.locked) plan.locked.confirmedAt = Date.now();
  issued = null; session.lastSigningFailure = null;if(plan.kind==="nonce-setup")session.nonceReady=true;await save(); statusCache.invalidate();
  if (plan.kind.startsWith("er-")) {erDelegated.invalidate();pool?.invalidate();}
  if (plan.kind === "uploader") startUpload();
  return { signatures, confirmed: true };
}

async function negativeChecks() {
  if (er) throw Error("use_er_claw_timing_test");
  const locked = session.attempts.at(-1);
  if (!locked?.callbackSignature) throw Error("verified_callback_required");
  await cluster();
  const result = decodeAttempt(await connection.getAccountInfo(new PublicKey(locked.attempt)), manifest, locked);
  const [scoped] = PublicKey.findProgramAddressSync([Buffer.from("identity"), program.toBuffer()], new PublicKey(manifest.vrfProgram));
  const { TransactionInstruction } = await import("@solana/web3.js");
  const data = Buffer.concat([discriminator("global:consume_probe"), Buffer.from(result.randomness, "hex"), u64(locked.nonce)]);
  const block = await connection.getLatestBlockhash();
  const simulate = async instruction => {
    const tx = new Transaction({ feePayer: payer, ...block }).add(instruction);
    return (await connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), { sigVerify: false, replaceRecentBlockhash: true })).value;
  };
  const outcomes = [];
  for (const [name, identity, signer, errorName] of [["wrong_callback_identity", payer, true, "ConstraintAddress"],
    ["unsigned_scoped_identity", scoped, false, "AccountNotSigner"]]) {
    const value = await simulate(new TransactionInstruction({ programId: program, data, keys: [
      { pubkey: identity, isSigner: signer, isWritable: false }, { pubkey: new PublicKey(locked.attempt), isSigner: false, isWritable: true }] }));
    if (!value.err || !value.logs?.some(line => line.includes(errorName))) throw Error("negative_callback_check_failed");
    outcomes.push({ name, rejected: true, error: errorName });
  }
  const duplicate = locked.requestAuthority && locked.requestAuthority !== payer.toBase58()
    ? requestSponsoredProbe(manifest, new PublicKey(locked.requestAuthority), locked.nonce, locked.count, locked.target, locked.threshold, Buffer.from(locked.seed, "hex"))
    : requestProbe(manifest, locked.nonce, locked.count, locked.target, locked.threshold, Buffer.from(locked.seed, "hex"));
  const value = await simulate(duplicate.instruction);
  if (!value.err || !value.logs?.some(line => /already in use|already initialized/i.test(line))) throw Error("duplicate_request_check_failed");
  const after = decodeAttempt(await connection.getAccountInfo(new PublicKey(locked.attempt)), manifest, locked);
  if (JSON.stringify(after) !== JSON.stringify(result)) throw Error("negative_checks_changed_state");
  outcomes.push({ name: "duplicate_nonce", rejected: true });
  session.negativeChecks = outcomes; await save();
  statusCache.invalidate();
  return { simulationsOnly: true, accountUnchanged: true, outcomes };
}

const server = createServer(async (req, res) => {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'none'" };
  const cors=req.url.startsWith("/api/player/")&&req.headers.origin===runtimeConfig.playerOrigin?{"Access-Control-Allow-Origin":runtimeConfig.playerOrigin,Vary:"Origin"}:{};
  const respond = (status, value, type = "application/json") => { res.writeHead(status, { ...headers,...cors, "Content-Type": type }); res.end(typeof value === "string" ? value : JSON.stringify(value)); };
  const localHealth=req.method==="GET"&&req.url==="/healthz"&&req.headers.host===`127.0.0.1:${port}`&&["127.0.0.1","::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
  if (req.headers.host !== runtimeConfig.expectedHost&&!localHealth) return respond(403, { error: "invalid_host" });
  const requestUrl = new URL(req.url, origin), path = requestUrl.pathname;
  try {
    if(req.method==="GET"&&path==="/healthz")return respond(200,{ok:true,cluster:"devnet",storage:sqlStore?"postgres":"sqlite"});
    if(req.method==="OPTIONS"&&path.startsWith("/api/player/")){
      if(req.headers.origin!==runtimeConfig.playerOrigin)return respond(403,{error:"invalid_origin"});
      res.writeHead(204,{...headers,"Access-Control-Allow-Origin":runtimeConfig.playerOrigin,"Access-Control-Allow-Methods":"GET,POST,OPTIONS","Access-Control-Allow-Headers":"Content-Type,X-Cato-Player-Session","Access-Control-Max-Age":"600",Vary:"Origin"});res.end();return;
    }
    const assets = { "/": ["scripts/devnet-wallet/index.html", "text/html"], "/app.js": ["scripts/devnet-wallet/app.js", "text/javascript"],
      "/style.css": ["scripts/devnet-wallet/style.css", "text/css"], "/web3.js": [new URL("./index.iife.min.js", import.meta.resolve("@solana/web3.js")).href, "text/javascript"] };
    if (req.method === "GET" && assets[path]) { const [file, type] = assets[path]; return respond(200, await readFile(new URL(file, root), "utf8"), type); }
    // Fixed localhost upstream; never forwards bearer credentials or cookies.
    // Only GET/HEAD assets and the gated devnet page, no arbitrary proxy target.
    if (!runtimeConfig.hosted&&["GET", "HEAD"].includes(req.method) && (path === (er ? "/claw/devnet-er" : "/claw/devnet") || er && path === "/claw/play" || path.startsWith("/_next/") || path.startsWith("/claw/") && path !== "/claw/lab" && /\.[a-z0-9]+$/i.test(path))) {
      const upstream = localRequest({ hostname: "127.0.0.1", port: runtimeConfig.frontendPort, path: req.url, method: req.method,
        headers: { Host: `127.0.0.1:${runtimeConfig.frontendPort}`, ...(req.headers.accept ? { Accept: req.headers.accept } : {}) } }, incoming => {
        res.writeHead(incoming.statusCode ?? 502, { ...incoming.headers, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); incoming.pipe(res);
      });
      upstream.setTimeout(60000, () => upstream.destroy());
      upstream.on("error", () => { if (!res.headersSent) respond(503, "Local claw server is starting. Refresh shortly.", "text/plain"); else res.destroy(); });
      upstream.end(); return;
    }
    if (playerApi && await playerApi(req,requestUrl,respond)) return;
    const supplied = Buffer.from(req.headers.authorization?.replace(/^Bearer /, "") ?? ""), expected = Buffer.from(token);
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return respond(404, { error: "not_found" });
    if (req.method === "GET" && path === "/api/state") return respond(200, await state());
    if (req.method === "GET" && path === "/api/performance") return respond(200, await latencyProbe.get());
    if (req.method === "GET" && path === "/api/pool/state" && pool) return respond(200, await pool.status());
    if (req.method === "GET" && path === "/api/game/availability") return respond(200, await playerStatus.get());
    if (req.method === "GET" && path === "/api/game/result") return respond(200, await game.state(requestUrl.searchParams.get("id")));
    if (req.method !== "POST" || req.headers.origin !== origin || req.headers["content-type"] !== "application/json") return respond(403, { error: "invalid_origin_or_method" });
    if (busy) return respond(409, { error: "another_action_in_progress" });
    if (!["/api/deploy", "/api/probe", "/api/submit", "/api/negative-checks", "/api/game/plan", "/api/game/timing", "/api/sponsor/plan", "/api/sponsor/revoke", "/api/pool/plan", "/api/pool/pause", "/api/pool/return", "/api/cashier/plan"].includes(path)) return respond(404, { error: "not_found" });
    busy = true;
    try {
      let raw = ""; for await (const chunk of req) { raw += chunk; if (raw.length > 50000) throw Error("request_too_large"); }
      const body = JSON.parse(raw || "{}");
      const value = path.startsWith("/api/pool/") && pool ? await planPool(body,path.split("/").at(-1))
        : path === "/api/cashier/plan" ? await planCashier(body)
        : path === "/api/deploy" ? await planDeploy(body) : path === "/api/probe" ? await planProbe(body)
        : path === "/api/sponsor/plan" ? await planSponsor() : path === "/api/sponsor/revoke" ? await planSponsor(true)
        : path === "/api/game/plan" ? await game.plan(body.pull)
        : path === "/api/game/timing" ? await game.recordTiming(body.id, body.events)
        : path === "/api/negative-checks" ? await negativeChecks() : await submit(body);
      respond(200, value);
    } finally { busy = false; playerStatus.invalidate(); }
  } catch (error) {
    statusCache.invalidate();
    const message = safeRpcError(error);
    if (error.logs) console.error("Devnet program logs:", error.logs.slice(-12));
    respond(400, { error: message });
  }
});
async function planPool(body,action) {
  await cluster();
  const plan=await pool.plan(body,action==="plan"?"setup":action);
  if(plan.done)return plan;
  return prepare([plan.instructions],[],plan.description,plan.kind,null,true);
}
async function planCashier(body){
  if(!body||Object.keys(body).length)throw Error("invalid_cashier_request");await cluster();
  if(!manifest.verifiedArtifact.capabilities?.includes("devnet-cashier-v1")||!await deployed())throw Error("cashier_program_upgrade_required");
  const p=cashierAddresses(manifest),existing=await connection.getAccountInfo(p.cashier);
  if(existing){decodeCashier(existing,manifest,cashierKey.publicKey);return {done:true};}
  const balance=await connection.getBalance(cashierKey.publicKey),funding=Math.max(0,50_000_000-balance);
  return prepare([[...(funding?[SystemProgram.transfer({fromPubkey:payer,toPubkey:cashierKey.publicKey,lamports:funding})]:[]),
    ...initializeCashierInstruction(manifest,cashierKey.publicKey)]],[],
    "Initialize the Solana devnet USDC vault. Authorize only the separate cashier signer, capped at 1,000 test USDC per claim and 10,000 per UTC day. Fund that signer up to 0.05 devnet SOL for fees and receipt/ATA rent. The vault must be funded separately with devnet USDC. VRF signers receive no payout access.","cashier",null,true);
}
// Do the first full binary attestation before accepting a player's first drop.
try { await deployed(); } catch (error) { throw Error(safeRpcError(error)); }
server.listen(port, runtimeConfig.bind, () => console.log(runtimeConfig.hosted
  ? `CATO devnet backend listening on ${port}; Postgres coordinator active. Admin requires the configured private capability.`
  : `Devnet signer: ${origin}/#session=${token}\nPhantom authority: ${payer.toBase58()}\nRPC: ${endpoint.hostname} (devnet verified). The signing page never receives private keys.`));
