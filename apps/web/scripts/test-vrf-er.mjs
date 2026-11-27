import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Keypair, PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { ER_ENDPOINT, ER_VALIDATOR, ER_QUEUE, DELEGATION_PROGRAM, erSessionPhase, erAddress, erDelegationAddresses,
  initializeErSession, delegateErSession, requestErProbe, decodeErSession, decodeErAttempt, checkErDelegation, verifyErEndpoint } from "./lib/vrf-er.mjs";
import { discriminator, matchesCallback, u64 } from "./lib/vrf-deployment.mjs";
import { createAttemptReader } from "./lib/vrf-callbacks.mjs";
import { createSponsoredSender, encodeSignature } from "./lib/vrf-sponsor.mjs";
import { createRollupDeploymentVerifier, LOADER_V4 } from "./lib/vrf-program.mjs";

const manifest = JSON.parse(await readFile(new URL("../onchain/deployment.devnet.json", import.meta.url), "utf8"));
const key = Keypair.generate(), delegate = key.publicKey, admin = new PublicKey(manifest.adminAuthority), program = new PublicKey(manifest.vrfProbeProgram);
const [address, bump] = erAddress(manifest, delegate), now = 1_800_000_000_000;
for (const remaining of [0, 2, 20, 100, 499]) {
  assert.equal(erSessionPhase({ remaining, expiresAt: now / 1000 + 21600 }, now / 1000), "renew", "Returning a partly used session must refill its allowance");
}
assert.equal(erSessionPhase({ remaining: 500, expiresAt: now / 1000 + 21600 }, now / 1000), "delegate");
assert.equal(erSessionPhase({ remaining: 500, expiresAt: now / 1000 }, now / 1000), "renew");
const init = initializeErSession(manifest, delegate, now / 1000 + 21600);
assert.equal(init.data.length, 82); assert(init.keys[0].pubkey.equals(admin)); assert(init.keys[0].isSigner);
assert(init.data.subarray(8, 40).equals(delegate.toBuffer())); assert(init.data.subarray(40, 72).equals(ER_VALIDATOR.toBuffer()));
assert.equal(init.data.readUInt16LE(80), 500);
const renewal = initializeErSession(manifest, delegate, now / 1000 + 21600, true);
assert.equal(renewal.data.length, 18); assert.equal(renewal.data.readUInt16LE(16), 500);
assert.match(await readFile(new URL("../onchain/programs/claw-vrf-probe/src/lib.rs", import.meta.url), "utf8"), /MAX_SPONSORED_REQUESTS: u16 = 500;/);
const p = erDelegationAddresses(manifest, delegate), delegation = delegateErSession(manifest, delegate);
assert.deepEqual(delegation.keys.map(k => k.pubkey.toBase58()), [admin, p.buffer, p.record, p.metadata, address, ER_VALIDATOR, program, DELEGATION_PROGRAM, SystemProgram.programId].map(k => k.toBase58()));
assert.deepEqual(delegation.keys.filter(k => k.isSigner).map(k => k.pubkey.toBase58()), [admin.toBase58()]);
const request = requestErProbe(manifest, delegate, "0", 64, 7, "2147483648", Buffer.alloc(32, 7));
assert.equal(request.instruction.keys.length, 7); assert(request.instruction.keys[2].pubkey.equals(ER_QUEUE));
assert(request.attempt.equals(address)); assert(requestErProbe(manifest, delegate, "1", 128, 8, "0", Buffer.alloc(32)).attempt.equals(address), "Every request reuses the delegated account");
const data = Buffer.alloc(233); discriminator("account:ErSession").copy(data); admin.toBuffer().copy(data, 8); delegate.toBuffer().copy(data, 40);
ER_VALIDATOR.toBuffer().copy(data, 72); data.writeBigInt64LE(BigInt(now / 1000 + 21600), 104); data.writeUInt16LE(19, 112);
data.writeBigUInt64LE(1n, 114); data[122] = 1; data[123] = bump;
delegate.toBuffer().copy(data, 124); data.writeBigUInt64LE(0n, 156); data.writeUInt16LE(64, 164); data.writeUInt16LE(7, 166);
data.writeBigUInt64LE(2147483648n, 168); data.writeBigUInt64LE(100n, 176); data.writeBigUInt64LE(103n, 184); data[230] = 1; data[231] = 1; data[232] = bump;
const account = { owner: program, data };
const locked = { nonce: "0", count: 64, target: 7, threshold: "2147483648", seed: Buffer.alloc(32, 7).toString("hex"), attempt: address.toBase58(), bump, requestAuthority: delegate.toBase58() };
assert.equal(decodeErSession(account, manifest, delegate).remaining, 19);
for (const remaining of [0, 20, 100, 499, 500]) {
  const boundary = Buffer.from(data); boundary.writeUInt16LE(remaining, 112);
  assert.equal(decodeErSession({ ...account, data: boundary }, manifest, delegate).remaining, remaining);
}
const excessive = Buffer.from(data); excessive.writeUInt16LE(501, 112);
assert.throws(() => decodeErSession({ ...account, data: excessive }, manifest, delegate), /er_session_mismatch/);
assert.equal(decodeErAttempt(account, manifest, locked).success, true);
assert.equal(decodeErAttempt(account, manifest, { ...locked, nonce: "1" }), null, "Prior result cannot be observed as the new request");
for (const offset of [0, 8, 40, 72, 123, 156, 164, 166, 168, 232]) {
  const changed = Buffer.from(data); changed[offset] ^= 1;
  assert.throws(() => decodeErAttempt({ ...account, data: changed }, manifest, locked), undefined, `Reject changed bound field at ${offset}`);
}
assert.throws(() => decodeErSession({ ...account, owner: DELEGATION_PROGRAM }, manifest, delegate));
assert.throws(() => decodeErAttempt(account, manifest, { ...locked, nonce: "18446744073709551615", requestAuthority: admin.toBase58() }));
const recordBytes = Buffer.alloc(96); recordBytes.writeBigUInt64LE(100n); ER_VALIDATOR.toBuffer().copy(recordBytes, 8); program.toBuffer().copy(recordBytes, 40);
assert(checkErDelegation({ owner: DELEGATION_PROGRAM, data: recordBytes }, manifest));
recordBytes[8] ^= 1; assert.throws(() => checkErDelegation({ owner: DELEGATION_PROGRAM, data: recordBytes }, manifest));
await verifyErEndpoint(async (url, options) => { assert.equal(url, ER_ENDPOINT); assert.equal(JSON.parse(options.body).method, "getIdentity"); return { ok: true, json: async () => ({ result: { identity: ER_VALIDATOR.toBase58() } }) }; });
await assert.rejects(verifyErEndpoint(async () => ({ ok: true, json: async () => ({ result: { identity: admin.toBase58() } }) })), /validator_mismatch/);

const vrf = new PublicKey(manifest.vrfProgram), [identity] = PublicKey.findProgramAddressSync([Buffer.from("identity"), program.toBuffer()], vrf);
const cbData = Buffer.concat([discriminator("global:consume_er_probe"), Buffer.alloc(32), u64("0")]);
const tx = { transaction: { message: { instructions: [{ programId: vrf }] } }, meta: { err: null, innerInstructions: [{ instructions: [{ programId: program, accounts: [identity, address], data: encodeSignature(cbData) }] }] } };
const result = decodeErAttempt(account, manifest, locked), callback = (t, c, l, r) => matchesCallback(t, c, l, r, "consume_er_probe");
assert(callback(tx, manifest, locked, result)); assert(!matchesCallback(tx, manifest, locked, result), "ER and base callback handlers are distinct");
assert(!callback(tx, manifest, { ...locked, nonce: "1" }, result));
const receipt = encodeSignature(Buffer.alloc(64, 8));
const reader = createAttemptReader({ manifest, save: async () => {}, decode: decodeErAttempt, callback,
  hints: () => [{ signature: receipt, slot: 103 }], connection: { getAccountInfo: async () => account, getParsedTransaction: async () => tx } });
const verified = { ...locked, requestSignature: "request" }; await reader(verified); assert.equal(verified.callbackSignature, receipt);
const prior = { ...locked, nonce: "1", requestSignature: "next" };
await createAttemptReader({ manifest, save: async () => {}, decode: decodeErAttempt, callback,
  connection: { getAccountInfo: async () => account, getSignatureStatuses: async () => ({ value: [null] }) } })(prior);
assert.equal(prior.attemptObserved, false); assert.equal(prior.result.status, "pending"); assert(!prior.callbackSignature);

let sends = 0;
const sender = createSponsoredSender({ manifest, key, save: async () => {}, refreshAttempt: async () => {}, now: () => now,
  requestFactory: requestErProbe, permitState: async () => ({ remaining: 19, expiresAt: now / 1000 + 100 }),
  connection: { getLatestBlockhash: async () => ({ blockhash: admin.toBase58(), lastValidBlockHeight: 1000 }),
    sendRawTransaction: async bytes => { sends++; const t = VersionedTransaction.deserialize(bytes); const ix = t.message.compiledInstructions.at(-1);
      assert(Buffer.from(ix.data).subarray(0, 8).equals(discriminator("global:request_er_probe"))); return encodeSignature(t.signatures[0]); } } });
await sender({ ...locked, result: { status: "not_submitted" } }); assert.equal(sends, 1);

// Regression: the actual devnet ER projects the program as loader-v4, not L1's
// 36-byte loader-v3 Program account. Attest the code, never just accept its ID.
const code = Buffer.alloc(128, 9), full = Buffer.alloc(48 + 160);
full.writeBigUInt64LE(100n); admin.toBuffer().copy(full, 8); full.writeBigUInt64LE(1n, 40); code.copy(full, 48);
let clock = 0, codeReads = 0, headReads = 0;
const programAccount = { owner: LOADER_V4, executable: true, data: full };
const verifierOptions = { program, authority: admin, binary: code, now: () => clock,
  connection: {
    getAccountInfoAndContext: async (id, options) => { assert(id.equals(program)); assert.deepEqual(options.dataSlice, { offset: 0, length: 48 }); headReads++;
      return { context: { slot: 101 }, value: { ...programAccount, data: Buffer.from(programAccount.data.subarray(0, 48)) } }; },
    getAccountInfo: async (id, options) => { assert(id.equals(program)); assert.equal(options.minContextSlot, 101); codeReads++; return programAccount; },
  } };
const verifyProgram = createRollupDeploymentVerifier(verifierOptions);
const firstRead = verifyProgram(); assert.equal(firstRead, verifyProgram()); assert.equal(await firstRead, true);
await verifyProgram(); assert.equal(headReads, 1); assert.equal(codeReads, 1);
clock = 30001; assert.equal(await verifyProgram(), true); assert.equal(headReads, 2); assert.equal(codeReads, 1);
clock = 60002; full.writeBigUInt64LE(102n); assert.equal(await verifyProgram(), true); assert.equal(codeReads, 2);
for (const [offset, error] of [[8, /owner_authority_or_status/], [40, /owner_authority_or_status/], [48, /binary_mismatch/], [full.length - 1, /binary_mismatch/]]) {
  full[offset] ^= 1; await assert.rejects(createRollupDeploymentVerifier(verifierOptions)(), error); full[offset] ^= 1;
}
programAccount.owner = SystemProgram.programId; await assert.rejects(createRollupDeploymentVerifier(verifierOptions)(), /owner_authority_or_status/);
programAccount.owner = LOADER_V4; programAccount.executable = false; await assert.rejects(createRollupDeploymentVerifier(verifierOptions)(), /owner_authority_or_status/);
// MagicBlock now clones programs into the rollup as the raw ELF with no loader header (seen on devnet 2026-11-24
// for both the old and the new program). Accept that only when the bytes are exactly the verified build.
const elf = Buffer.concat([Buffer.from("7f454c46020101", "hex"), Buffer.alloc(200, 7)]);
const raw = { owner: LOADER_V4, executable: true, data: Buffer.from(elf) };
const rawOptions = { program, authority: admin, binary: elf, now: () => 0, connection: {
  getAccountInfoAndContext: async () => ({ context: { slot: 5 }, value: { ...raw, data: Buffer.from(raw.data.subarray(0, 48)) } }),
  getAccountInfo: async (id, options) => { assert.equal(options.minContextSlot, 5); return raw; } } };
assert.equal(await createRollupDeploymentVerifier(rawOptions)(), true);
raw.data[100] ^= 1; await assert.rejects(createRollupDeploymentVerifier(rawOptions)(), /binary_mismatch/); raw.data[100] ^= 1;
raw.data = Buffer.concat([elf, Buffer.alloc(8)]); await assert.rejects(createRollupDeploymentVerifier(rawOptions)(), /binary_mismatch/); raw.data = Buffer.from(elf);
raw.executable = false; await assert.rejects(createRollupDeploymentVerifier(rawOptions)(), /owner_authority_or_status/); raw.executable = true;
raw.owner = SystemProgram.programId; await assert.rejects(createRollupDeploymentVerifier(rawOptions)(), /owner_authority_or_status/); raw.owner = LOADER_V4;
console.log("PASS: pinned ER validator/queue/delegation owner, Anchor account ordering, strict 233-byte session binding, reusable account stale-result rejection, scoped callback/nonce verification, and fixed sponsored ER transaction signing.");
