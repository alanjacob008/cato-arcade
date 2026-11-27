import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { createAttemptReader } from "./lib/vrf-callbacks.mjs";
import { createVrfNotifications } from "./lib/vrf-notifications.mjs";
import { discriminator, requestProbe, u64 } from "./lib/vrf-deployment.mjs";
import { encodeSignature } from "./lib/vrf-sponsor.mjs";

const manifest = JSON.parse(await readFile(new URL("../onchain/deployment.devnet.json", import.meta.url), "utf8"));
const program = new PublicKey(manifest.vrfProbeProgram), vrf = new PublicKey(manifest.vrfProgram);
const authority = new PublicKey(manifest.adminAuthority), request = requestProbe(manifest, 99n, 64, 7, 2147483648n, Buffer.alloc(32));
const [identity] = PublicKey.findProgramAddressSync([Buffer.from("identity"), program.toBuffer()], vrf);
const signature = encodeSignature(Buffer.alloc(64, 9));
function fixture() {
  const data = Buffer.alloc(117); discriminator("account:Attempt").copy(data); authority.toBuffer().copy(data, 8);
  data.writeBigUInt64LE(99n, 40); data.writeUInt16LE(64, 48); data.writeUInt16LE(7, 50); data.writeBigUInt64LE(2147483648n, 52);
  data.writeBigUInt64LE(100n, 60); data.writeBigUInt64LE(103n, 68); data[114] = 1; data[115] = 1; data[116] = request.bump;
  const callback = Buffer.concat([discriminator("global:consume_probe"), Buffer.alloc(32), u64(99n)]);
  const tx = { transaction: { message: { instructions: [{ programId: vrf }] } }, meta: { err: null,
    innerInstructions: [{ instructions: [{ programId: program, accounts: [identity, request.attempt], data: encodeSignature(callback) }] }] } };
  const locked = { nonce: "99", count: 64, target: 7, threshold: "2147483648", bump: request.bump,
    attempt: request.attempt.toBase58(), requestSignature: "original-request" };
  return { account: { owner: program, data }, tx, locked };
}

const f = fixture(); let reads = 0, parsed = 0, release;
const reader = createAttemptReader({ manifest, save: async () => {}, now: () => 1234, hints: () => [{ signature, slot: 103 }],
  connection: {
    getAccountInfo: async (_address, options) => { reads++; assert.deepEqual(options, { commitment: "confirmed", minContextSlot: 103 }); return new Promise(resolve => { release = () => resolve(f.account); }); },
    getParsedTransaction: async (sig, options) => { parsed++; assert.equal(sig, signature); assert.equal(options.commitment, "confirmed"); return f.tx; },
    getSignaturesForAddress: async () => { throw Error("A verified pushed receipt needs no signature search"); },
  } });
const first = reader(f.locked), second = reader(f.locked); assert.equal(first, second);
assert.equal(reads, 1); assert.equal(parsed, 1, "Account and hinted callback reads start in parallel"); release(); await first;
assert.equal(f.locked.callbackSignature, signature); assert.equal(f.locked.callbackVerifiedAt, 1234);
await reader(f.locked); assert.equal(reads, 1, "Verified results are cached without new RPCs");

for (const hinted of [false, true]) {
  const item = fixture(); let searches = 0;
  const read = createAttemptReader({ manifest, save: async () => {}, hints: () => hinted ? [{ signature: "wrong-receipt", slot: 103 }] : [],
    connection: { getAccountInfo: async () => item.account,
      getParsedTransaction: async sig => sig === signature ? item.tx : { ...item.tx, meta: { err: "failed" } },
      getSignaturesForAddress: async () => { searches++; return [{ signature, err: null }]; } } });
  await read(item.locked); assert.equal(item.locked.callbackSignature, signature); assert.equal(searches, 1, "Missing or invalid hints use the original verified polling path");
}
const invalid = fixture(); invalid.account.owner = SystemProgram.programId;
await assert.rejects(createAttemptReader({ manifest, save: async () => {}, hints: () => [{ signature, slot: 103 }],
  connection: { getAccountInfo: async () => invalid.account, getParsedTransaction: async () => invalid.tx } })(invalid.locked), /attempt_mismatch/);
assert.equal(invalid.locked.callbackSignature, undefined, "Push never overrides owner or locked-input validation");
const pending = fixture(); pending.account.data[115] = 0;
await createAttemptReader({ manifest, save: async () => {}, hints: () => [{ signature, slot: 103 }],
  connection: { getAccountInfo: async () => pending.account, getParsedTransaction: async () => pending.tx } })(pending.locked);
assert.equal(pending.locked.callbackSignature, undefined, "A notification cannot fulfill a pending account");

const unchanged=fixture();unchanged.account.data[115]=0;
let durableWrites=0,failWrite=false;
const polling=createAttemptReader({manifest,now:()=>1234,hints:()=>[{signature,slot:103}],
  save:async()=>{durableWrites++;if(failWrite)throw Error("durable_write_failed");},
  connection:{getAccountInfo:async()=>unchanged.account,getParsedTransaction:async()=>unchanged.tx}});
await polling(unchanged.locked);assert.equal(durableWrites,1);
await polling(unchanged.locked);await polling(unchanged.locked);
assert.equal(durableWrites,1,"Unchanged pending polls must not rewrite encrypted signer state");
unchanged.account.data[115]=1;failWrite=true;
await assert.rejects(polling(unchanged.locked),/durable_write_failed/);
assert.equal(durableWrites,2);failWrite=false;
await polling(unchanged.locked);assert.equal(durableWrites,3,"A proof whose save failed must be persisted before returning on retry");
await polling(unchanged.locked);assert.equal(durableWrites,3);

class FakeSocket extends EventEmitter {
  static latest;
  constructor(url, options) { super(); this.url = url; this.options = options; FakeSocket.latest = this; }
  send(value) { this.sent = JSON.parse(value); }
  terminate() { this.emit("close"); }
}
const notified = [];
const notifications = createVrfNotifications({ endpoint: "https://devnet.helius-rpc.com/?api-key=not-a-real-key",
  origin: "https://cato-claw-arcade.vercel.app", program: program.toBase58(), Socket: FakeSocket, onCallback: hint => notified.push(hint) });
const socket = FakeSocket.latest; assert(socket.url.startsWith("wss:")); assert.equal(socket.options.origin, "https://cato-claw-arcade.vercel.app");
socket.emit("open"); assert.deepEqual(socket.sent.params, [{ mentions: [program.toBase58()] }, { commitment: "confirmed" }]);
socket.emit("message", JSON.stringify({ id: 1, result: 5 })); assert.equal(notifications.state().connected, true);
const message = { method: "logsNotification", params: { subscription: 5, result: { context: { slot: 103 }, value: {
  err: null, signature, logs: ["Program log: Instruction: ConsumeProbe"] } } } };
socket.emit("message", "invalid-json"); socket.emit("message", JSON.stringify({ ...message, params: { ...message.params, subscription: 6 } }));
const failed = structuredClone(message); failed.params.result.value.err = "failed"; socket.emit("message", JSON.stringify(failed));
socket.emit("message", JSON.stringify(message)); await Promise.resolve(); await Promise.resolve();
assert.deepEqual(notified, [{ signature, slot: 103 }]); assert.equal(notifications.state().received, 1);
assert(!JSON.stringify(notifications.state()).includes("not-a-real-key")); notifications.close(); assert.equal(notifications.state().connected, false);
console.log("PASS: authenticated confirmed push notifications, strict hint filtering, parallel account/receipt checks, single-flight verification, invalid-hint HTTP fallback, and no result from invalid or pending accounts.");
