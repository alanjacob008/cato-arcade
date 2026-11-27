import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import vm from "node:vm";
import ts from "typescript";

// The player client must work with any wallet from the site's picker, through the PlayerWallet interface only.
const file = new URL("../components/claw/authoritativeClient.ts", import.meta.url);
const text = await readFile(file, "utf8");
assert(!text.includes("window.phantom"), "authoritativeClient.ts must not talk to Phantom directly");
const source = ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function load(fetch, overrides = {}) {
  const storage = new Map(), compiled = { exports: {} };
  vm.runInNewContext(source, { exports: compiled.exports, module: compiled, fetch, Date, AbortSignal, TextEncoder, setTimeout, clearTimeout, crypto: { randomUUID },
    sessionStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) }, ...overrides });
  return compiled.exports.createAuthoritativeClient;
}
const signatureBytes = Uint8Array.from({ length: 64 }, (_, i) => i);
const hex = bytes => Array.from(bytes, b => b.toString(16).padStart(2, "0")).join("");
function fakeWallet(address, canSign = true) {
  const wallet = { current: address, signed: null,
    address: () => wallet.current,
    connect: async () => wallet.current,
    signTransaction: async value => value };
  if (canSign) wallet.signMessage = async message => { wallet.signed = new TextDecoder().decode(message); return signatureBytes; };
  else wallet.signMessage = async () => { throw Error("wallet_cannot_sign_messages"); };
  return wallet;
}
let loginBody = null;
const state = { namespace: "devnet-test-pg-v1", wallet: "WalletA", revision: 1 };
const fetch = async (url, options = {}) => {
  const body = options.body ? JSON.parse(options.body) : null; let value;
  if (url.endsWith("/challenge")) value = { id: "c1", message: "sign this challenge", expires: Date.now() + 60000 };
  else if (url.endsWith("/login")) { loginBody = body; value = { token: "a".repeat(64), state }; }
  else if (url.endsWith("/state")) value = state;
  else throw Error(`unexpected request ${url}`);
  return { ok: true, json: async () => value };
};

// Sign-in posts the wallet's own address and a lowercase-hex signature of the challenge text.
const wallet = fakeWallet("WalletA"), client = load(fetch)(wallet);
await client.connect();
assert.equal(wallet.signed, "sign this challenge");
assert.deepEqual(loginBody, { id: "c1", wallet: "WalletA", signature: hex(signatureBytes) });

// Switching account after sign-in blocks play until the player signs in again.
wallet.current = "WalletB";
await assert.rejects(client.begin({ requestId: "r1", revision: 1, aim: { x: 0, z: 0 }, tier: 0 }), /Reconnect your wallet before playing\./);

// A wallet that cannot sign messages gets a clear error, not a crash.
await assert.rejects(load(fetch)(fakeWallet("WalletC", false)).connect(), /wallet_cannot_sign_messages/);

// Backend unreachable, mid-redeploy (Vercel HTML error page) or timing out: one clear message, not a parse error.
const unavailable = /The game is unavailable right now/;
await assert.rejects(load(async () => { throw Error("connect ECONNREFUSED"); })(fakeWallet("WalletA")).availability(), unavailable);
const htmlPage = async () => ({ ok: false, status: 502, json: async () => { throw SyntaxError("Unexpected token '<', \"<!DOCTYPE \"... is not valid JSON"); } });
await assert.rejects(load(htmlPage)(fakeWallet("WalletA")).availability(), unavailable);
const timeout = async () => { const e = Error("The operation was aborted due to timeout"); e.name = "TimeoutError"; throw e; };
await assert.rejects(load(timeout)(fakeWallet("WalletA")).availability(), unavailable);
// Backend errors with a code still surface the code (callers branch on them).
const coded = async () => ({ ok: false, status: 409, json: async () => ({ error: "player_attempt_pending" }) });
await assert.rejects(load(coded)(fakeWallet("WalletA")).availability(), /^Error: player_attempt_pending$/);
let readCalls=0;
const recovered=load(async()=>{if(++readCalls===1)throw Error("socket reset");return {ok:true,json:async()=>({deployed:true,sponsor:{ready:true,remaining:3982}})};})(fakeWallet("WalletA"));
assert.equal((await recovered.availability()).sponsor.remaining,3982);assert.equal(readCalls,2,"A read-only availability check recovers from one transient network failure");
let failedReads=0;await assert.rejects(load(async()=>{failedReads++;throw Error("offline");})(fakeWallet("WalletA")).availability(),unavailable);assert.equal(failedReads,2,"Status retries are bounded");
let elapsed=0;const deadlines=[];
await assert.rejects(load(async(_url,options)=>{assert.equal(options.cache,"no-store");elapsed=4300;throw Error("timeout");},
  {Date:{now:()=>elapsed},AbortSignal:{timeout:ms=>{deadlines.push(ms);return new AbortController().signal;}}})(fakeWallet("WalletA")).availability(),unavailable);
assert.deepEqual(deadlines,[4000,3700],"The retry shares the original eight-second read budget");
let proxyReads=0;const proxyRecovery=load(async()=>++proxyReads===1?{ok:false,status:502,json:async()=>({error:"preview_service_unavailable"})}:{ok:true,json:async()=>({deployed:true})})(fakeWallet("WalletA"));
assert((await proxyRecovery.availability()).deployed);assert.equal(proxyReads,2,"Loopback gateway outages use the same retryable connection state");
let mutationCalls=0;const lockedClient=load(async(url,options)=>{if(url.endsWith("/play")){mutationCalls++;throw Error("socket reset after submission");}return fetch(url,options);})(fakeWallet("WalletA"));
await lockedClient.connect();const intent={requestId:"locked-once",revision:1,aim:{x:0,z:0},tier:0};
await assert.rejects(lockedClient.begin(intent),unavailable);assert.equal(mutationCalls,1,"Play mutations must never be automatically resent");assert.equal(lockedClient.queued().requestId,intent.requestId,"The original locked intent remains recoverable");
// A busy backend (new-wallet pile lane full) is a retryable outage, not a raw error code.
let busyReads=0;await assert.rejects(load(async()=>{busyReads++;return {ok:false,status:503,json:async()=>({error:"claw_service_busy_retry"})};})(fakeWallet("WalletA")).availability(),unavailable);
assert.equal(busyReads,2,"Busy reads retry once within the read budget");
let busyLogins=0;await assert.rejects(load(async(url,options)=>{if(url.endsWith("/login")){busyLogins++;return {ok:false,status:503,json:async()=>({error:"claw_service_busy_retry"})};}return fetch(url,options);})(fakeWallet("WalletA")).connect(),unavailable);
assert.equal(busyLogins,1,"Sign-in is not resent automatically");
// A stored token is never reused for another wallet, and signing out forgets and revokes it.
{const calls=[],tokenA="a".repeat(64),tokenB="b".repeat(64);let logins=0;
  const recording=async(url,options={})=>{const route=url.slice(url.lastIndexOf("/")+1),token=options.headers?.["X-Cato-Player-Session"]??"";calls.push(route+":"+token.slice(0,1));
    if(route==="logout"){assert.equal(options.method,"POST");assert.equal(options.body,"{}");return {ok:true,json:async()=>({ok:true})};}
    if(route==="login")return {ok:true,json:async()=>({token:++logins===1?tokenA:tokenB,state})};
    return fetch(url,options);};
  const tab=load(recording),player=fakeWallet("WalletA");
  await tab(player).connect();await tab(player).connect();
  assert.deepEqual(calls,["challenge:","login:","state:a"],"Same wallet restores its own session without a new signature");
  calls.length=0;player.current="WalletB";await tab(player).connect();
  assert.deepEqual(calls,["logout:a","challenge:","login:"],"Switching wallets revokes the other wallet's token instead of reusing it");
  calls.length=0;const signedIn=tab(player);await signedIn.connect();assert.deepEqual(calls,["state:b"]);
  calls.length=0;signedIn.signOut();assert.deepEqual(calls,["logout:b"],"Sign-out revokes the presenting session");
  await assert.rejects(signedIn.begin(intent),/Reconnect your wallet before playing\./,"A signed-out client cannot play");
  calls.length=0;await tab(player).connect();assert.deepEqual(calls,["challenge:","login:"],"Signed-out tokens are not restored from storage");}
console.log("PASS: player client signs in through any site wallet, blocks a switched account, never reuses a token across wallets, signs out by revoking its session, and surfaces unsigned-wallet, busy and offline errors.");
