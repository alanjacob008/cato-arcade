import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Keypair, PublicKey, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import { sponsorAddress, decodeSponsor, grantSponsor, revokeSponsor, requestSponsoredProbe, decodeAttempt,
  discriminator, extendProgram, upgradeProgram, LOADER, SPONSOR_REQUESTS, SPONSOR_FUNDING, decodeBase58 } from "./lib/vrf-deployment.mjs";
import { createSponsoredSender, encodeSignature } from "./lib/vrf-sponsor.mjs";

const manifest = JSON.parse(await readFile(new URL("../onchain/deployment.devnet.json", import.meta.url), "utf8"));
const key = Keypair.generate(), admin = new PublicKey(manifest.adminAuthority), program = new PublicKey(manifest.vrfProbeProgram);
const [address, bump] = sponsorAddress(manifest, key.publicKey);
const now = 1_800_000_000_000, expires = now / 1000 + 21600;
const grant = grantSponsor(manifest, key.publicKey, expires);
assert(grant.keys[0].pubkey.equals(admin)); assert(grant.keys[0].isSigner); assert(grant.keys[1].pubkey.equals(address));
assert.equal(grant.data.length, 50); assert(grant.data.subarray(8, 40).equals(key.publicKey.toBuffer()));
assert.equal(Number(grant.data.readBigInt64LE(40)), expires); assert.equal(grant.data.readUInt16LE(48), 500);
const renewal = grantSponsor(manifest, key.publicKey, expires, true);
assert.equal(renewal.data.length, 18); assert.equal(renewal.data.readUInt16LE(16), 500);
assert(revokeSponsor(manifest, key.publicKey).keys[0].pubkey.equals(admin));
assert.equal(SPONSOR_REQUESTS, 500); assert.equal(SPONSOR_FUNDING, 50_000_000);
const bytes = Buffer.alloc(83); discriminator("account:SponsorSession").copy(bytes); admin.toBuffer().copy(bytes, 8);
key.publicKey.toBuffer().copy(bytes, 40); bytes.writeBigInt64LE(BigInt(expires), 72); bytes.writeUInt16LE(20, 80); bytes[82] = bump;
const permit = { owner: program, data: bytes };
assert.deepEqual(decodeSponsor(permit, manifest, key.publicKey), { remaining: 20, expiresAt: expires });
for (const remaining of [0, 100, 499, 500]) {
  const boundary = Buffer.from(bytes); boundary.writeUInt16LE(remaining, 80);
  assert.equal(decodeSponsor({ ...permit, data: boundary }, manifest, key.publicKey).remaining, remaining);
}
const excessive = Buffer.from(bytes); excessive.writeUInt16LE(501, 80);
assert.throws(() => decodeSponsor({ ...permit, data: excessive }, manifest, key.publicKey), /sponsor_account_mismatch/);
assert.throws(() => decodeSponsor({ ...permit, owner: SystemProgram.programId }, manifest, key.publicKey));
assert.throws(() => decodeSponsor(permit, manifest, Keypair.generate().publicKey));
const request = requestSponsoredProbe(manifest, key.publicKey, "123", 64, 7, "1113557535", Buffer.alloc(32, 7));
assert.equal(request.instruction.keys.length, 8); assert(request.instruction.keys[0].pubkey.equals(key.publicKey));
assert(request.instruction.keys[2].pubkey.equals(address)); assert(request.instruction.data.subarray(0, 8).equals(discriminator("global:request_sponsored_probe")));
const locked = { nonce: "123", count: 64, target: 7, threshold: "1113557535", seed: Buffer.alloc(32, 7).toString("hex"),
  requestAuthority: key.publicKey.toBase58(), attempt: request.attempt.toBase58(), bump: request.bump };
const attempt = Buffer.alloc(117); discriminator("account:Attempt").copy(attempt); key.publicKey.toBuffer().copy(attempt, 8);
attempt.writeBigUInt64LE(123n, 40); attempt.writeUInt16LE(64, 48); attempt.writeUInt16LE(7, 50); attempt.writeBigUInt64LE(1113557535n, 52); attempt[116] = request.bump;
assert.equal(decodeAttempt({ owner: program, data: attempt }, manifest, locked).status, "pending");
assert.throws(() => decodeAttempt({ owner: program, data: attempt }, manifest, { ...locked, requestAuthority: admin.toBase58() }));
const buffer = Keypair.generate().publicKey;
assert.equal(upgradeProgram(admin, program, buffer).data.readUInt32LE(), 3);
assert(upgradeProgram(admin, program, buffer).keys[3].pubkey.equals(admin), "Upgrade spill returns to wallet");
assert.equal(extendProgram(admin, program, 10240).data.readUInt32LE(), 6);
assert.throws(() => extendProgram(admin, program, 1));
assert(upgradeProgram(admin, program, buffer).programId.equals(LOADER));

let sends = 0, saves = 0, failOnce = true;
const sentBytes = [];
const connection = {
  getMultipleAccountsInfo: async () => [permit, { lamports: SPONSOR_FUNDING }],
  getLatestBlockhash: async () => ({ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 1000 }),
  getBlockHeight: async () => 900, getSignatureStatuses: async () => ({ value: [null] }),
  sendRawTransaction: async bytes => {
    sends++; assert(saves > 0, "Signed bytes must be durable before any send"); sentBytes.push(Buffer.from(bytes));
    if (failOnce) { failOnce = false; throw Error("devnet_rpc_unavailable"); }
    const tx = VersionedTransaction.deserialize(bytes); assert(tx.message.staticAccountKeys[0].equals(key.publicKey));
    return encodeSignature(tx.signatures[0]);
  },
};
const sender = createSponsoredSender({ connection, key, manifest, now: () => now, save: async () => { saves++; },
  refreshAttempt: async a => {
    // Mirror the server: a durable signature is "pending" even when an RPC
    // timeout happened before the consumer account reached the chain.
    a.result = { status: a.requestSignature ? "pending" : "not_submitted" };
    a.attemptObserved = false;
  } });
await assert.rejects(sender(locked), /devnet_rpc_unavailable/);
const firstSignature = locked.requestSignature, firstSeed = locked.seed;
await Promise.all([sender(locked), sender(locked)]);
assert.equal(sends, 2); assert.equal(locked.confirmedAt, undefined, "Broadcast acknowledgement must never be reported as confirmation");
assert.equal(locked.broadcastAt, now); assert(sentBytes[0].equals(sentBytes[1]), "Timeout retries rebroadcast identical bytes");
assert.equal(locked.requestSignature, firstSignature); assert.equal(locked.seed, firstSeed);
assert(decodeBase58(firstSignature).equals(VersionedTransaction.deserialize(sentBytes[0]).signatures[0]));
const observedSender = createSponsoredSender({ connection, key, manifest, now: () => now, save: async () => { saves++; },
  refreshAttempt: async a => { a.result = { status: "pending" }; a.attemptObserved = true; } });
await observedSender({ ...locked });
assert.equal(sends, 2, "An existing onchain attempt never creates or sends replacement randomness");
bytes.writeUInt16LE(0, 80);
await assert.rejects(sender({ ...locked, nonce: "124", sponsorWire: undefined, requestSignature: undefined }), /sponsor_setup_required/);
bytes.writeUInt16LE(20, 80); bytes.writeBigInt64LE(BigInt(now / 1000 - 1), 72);
await assert.rejects(sender({ ...locked, nonce: "125", sponsorWire: undefined, requestSignature: undefined }), /sponsor_setup_required/);
assert.equal(sends, 2, "Expired/exhausted permits cannot spend sponsor funds");
console.log("PASS: bounded sponsor grant/revoke encoding, strict delegate/owner/authority decoding, sponsor-funded request and attempt binding, upgrade spill destination, identical-byte timeout retries, single-flight sends, and expired/exhausted denial.");
