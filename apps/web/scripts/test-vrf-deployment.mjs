import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createHash, webcrypto } from "node:crypto";
import { createDeploymentVerifier } from "./lib/vrf-program.mjs";
import { Keypair, PublicKey, Transaction, VersionedTransaction, TransactionMessage, ComputeBudgetProgram, ComputeBudgetInstruction, SystemProgram, SystemInstruction, NONCE_ACCOUNT_LENGTH, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY } from "@solana/web3.js";
import { LOADER, CHUNK_BYTES, initializeBuffer, writeBuffer, deployProgram, missingChunks, requestProbe,
  discriminator, decodeAttempt, sameMessage, matchesCallback, decodeBase58, u64, setBufferAuthority,
  readDurableNonce, durableTransaction, checkSigningLifetime, UPLOAD_FUNDING_LAMPORTS,
  walletTransaction, signedWalletTransaction, walletMessageDifference, nextProgramUpgrade } from "./lib/vrf-deployment.mjs";

const config = JSON.parse(await readFile(new URL("../onchain/deployment.devnet.json", import.meta.url), "utf8"));
const payer = new PublicKey(config.adminAuthority), program = new PublicKey(config.vrfProbeProgram), buffer = Keypair.generate().publicKey;
const init = initializeBuffer(buffer, payer);
assert.deepEqual([...init.data], [0, 0, 0, 0]);
assert(init.programId.equals(LOADER)); assert(init.keys[0].pubkey.equals(buffer)); assert(!init.keys[1].isSigner);
const payload = Buffer.alloc(CHUNK_BYTES, 123), ix = writeBuffer(buffer, payer, 1800, payload);
assert.equal(ix.data.readUInt32LE(0), 1); assert.equal(ix.data.readUInt32LE(4), 1800);
assert.equal(ix.data.readBigUInt64LE(8), 900n); assert(ix.data.subarray(16).equals(payload));
assert(ix.keys[1].isSigner); assert(!ix.keys[1].isWritable);
const tx = new Transaction({ feePayer: payer, recentBlockhash: Keypair.generate().publicKey.toBase58() }).add(ix);
assert(tx.serialize({ requireAllSignatures: false }).length <= 1232);
assert.throws(() => writeBuffer(buffer, payer, -1, payload));
assert.throws(() => writeBuffer(buffer, payer, 0, Buffer.alloc(CHUNK_BYTES + 1)));
const deploy = deployProgram(payer, program, buffer, 177600);
assert.equal(deploy.data.toString("hex"), "02000000c0b5020000000000");
assert.equal(deploy.keys.length, 8);
assert(deploy.keys[4].pubkey.equals(SYSVAR_RENT_PUBKEY)); assert(deploy.keys[5].pubkey.equals(SYSVAR_CLOCK_PUBKEY));
assert(deploy.keys[6].pubkey.equals(SystemProgram.programId)); assert(deploy.keys[7].isSigner);

// The real loader updates ProgramData.slot during extension and rejects an
// upgrade in that slot. Plan one instruction per approval, then wait for a
// later confirmed slot before preparing the next one. A resumed upload uses
// actual onchain capacity rather than replaying an already-confirmed extension.
const programData = { owner: LOADER, data: Buffer.alloc(45 + 177600) };
programData.data.writeUInt32LE(3); programData.data.writeBigUInt64LE(100n, 4);
programData.data[12] = 1; payer.toBuffer().copy(programData.data, 13);
let slot = 100, waits = 0;
const upgradeOptions = { connection: { getSlot: async commitment => { assert.equal(commitment, "confirmed"); return slot; } },
  authority: payer, program, buffer, bytes: 233896, account: programData,
  sleep: async () => { waits++; slot++; } };
const expansion = await nextProgramUpgrade(upgradeOptions);
assert.equal(expansion.kind, "extend"); assert.equal(expansion.instruction.data.readUInt32LE(), 6);
assert.equal(expansion.instruction.data.readUInt32LE(4), 61440); assert.equal(waits, 1);
const expanded = { owner: LOADER, data: Buffer.alloc(45 + 239040) };
programData.data.subarray(0, 45).copy(expanded.data); expanded.data.writeBigUInt64LE(BigInt(slot), 4);
const finalUpgrade = await nextProgramUpgrade({ ...upgradeOptions, account: expanded });
assert.equal(finalUpgrade.kind, "upgrade"); assert.equal(finalUpgrade.instruction.data.readUInt32LE(), 3);
assert.equal(waits, 2, "Upgrade approval must wait beyond the extension slot");
const resumedUpgrade = await nextProgramUpgrade({ ...upgradeOptions, account: expanded });
assert.equal(resumedUpgrade.kind, "upgrade"); assert.equal(waits, 2);
await assert.rejects(nextProgramUpgrade({ ...upgradeOptions, sleep: async () => {},
  connection: { getSlot: async () => 100 } }), /program_slot_pending_retry_same_step/);
await assert.rejects(nextProgramUpgrade({ ...upgradeOptions, account: { ...expanded, owner: SystemProgram.programId } }), /unexpected_programdata_account/);

const binary = Buffer.alloc(2000, 7), data = Buffer.alloc(37 + binary.length);
data.writeUInt32LE(1); data[4] = 1; payer.toBuffer().copy(data, 5);
assert.equal(missingChunks(data, binary, payer).length, 3);
binary.subarray(0, 900).copy(data, 37);
assert.deepEqual(missingChunks(data, binary, payer).map(x => x.offset), [900, 1800]);
assert.throws(() => missingChunks(data, binary, buffer));
binary.copy(data, 37); assert.equal(missingChunks(data, binary, payer).length, 0);
data[4] = 0; assert.throws(() => missingChunks(data, binary, payer));

const signedPayer = Keypair.generate(), signed = new Transaction({ feePayer: signedPayer.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
  .add(writeBuffer(buffer, signedPayer.publicKey, 0, payload));
const issued = Transaction.from(signed.serialize({ requireAllSignatures: false }));
signed.sign(signedPayer); assert(sameMessage(signed, issued)); assert(signed.verifySignatures());
const edited = Transaction.from(signed.serialize()); edited.instructions[0].data[4] = 1;
assert(!sameMessage(edited, issued)); assert(!edited.verifySignatures());

// A slow wallet approval may outlive many recent-blockhash windows. It must still
// validate against the same durable nonce, and must fail after that nonce is used.
const nonceKey = Keypair.generate(), nonceValue = Keypair.generate().publicKey.toBase58();
const nonceData = Buffer.alloc(NONCE_ACCOUNT_LENGTH); nonceData.writeUInt32LE(1); nonceData.writeUInt32LE(1, 4);
payer.toBuffer().copy(nonceData, 8); new PublicKey(nonceValue).toBuffer().copy(nonceData, 40); nonceData.writeBigUInt64LE(5000n, 72);
const nonceAccount = { owner: SystemProgram.programId, data: nonceData };
assert.equal(readDurableNonce(nonceAccount, payer), nonceValue);
assert.throws(() => readDurableNonce(nonceAccount, buffer));
assert.throws(() => readDurableNonce({ ...nonceAccount, owner: LOADER }, payer));
const durable = durableTransaction(payer, nonceKey.publicKey, nonceValue, [deploy]);
assert.equal(SystemInstruction.decodeInstructionType(durable.instructions[0]), "AdvanceNonceAccount");
assert(SystemInstruction.decodeNonceAdvance(durable.instructions[0]).noncePubkey.equals(nonceKey.publicKey));
assert(durable.instructions[1].data.equals(deploy.data));
assert(durable.serialize({ requireAllSignatures: false }).length <= 1232);
const durablePlan = { nonce: { account: nonceKey.publicKey, value: nonceValue }, block: null };
assert.doesNotThrow(() => checkSigningLifetime(durablePlan, nonceValue, 1_000_000_000));
assert.throws(() => checkSigningLifetime(durablePlan, Keypair.generate().publicKey.toBase58(), 0), { message: "nonce_consumed_refresh_same_step" });
assert.throws(() => checkSigningLifetime({ block: { lastValidBlockHeight: 100 } }, null, 101), { message: "blockhash_expired_retry_same_step" });
const uploader = Keypair.generate();
const authorize = setBufferAuthority(buffer, payer, uploader.publicKey);
assert.equal(authorize.data.toString("hex"), "04000000");
assert(authorize.keys[0].pubkey.equals(buffer)); assert(authorize.keys[1].pubkey.equals(payer)); assert(authorize.keys[1].isSigner);
assert(authorize.keys[2].pubkey.equals(uploader.publicKey));
// The upload signer pays one 5,000-lamport fee per chunk, then the durable-nonce rent, and must not be left
// with a non-zero balance below the rent-exempt minimum. Measured on devnet 2026-11-24: nonce rent 1,056,640,
// empty-account minimum 650,240; a 618,920-byte build is 688 chunks. 5,000,000 left the fresh deployment short.
const uploadCost = Math.ceil(618920 / CHUNK_BYTES) * 5000 + 1_056_640 + 650_240 + 4 * 10_000;
assert(UPLOAD_FUNDING_LAMPORTS >= uploadCost, `upload funding ${UPLOAD_FUNDING_LAMPORTS} < ${uploadCost}`);
assert(UPLOAD_FUNDING_LAMPORTS <= 10_000_000, "keep the temporary signer's exposure small; unused funds are refunded");
const nonceSetup = new Transaction({ feePayer: uploader.publicKey, recentBlockhash: Keypair.generate().publicKey.toBase58() })
  .add(...SystemProgram.createNonceAccount({ fromPubkey: uploader.publicKey, noncePubkey: nonceKey.publicKey, authorizedPubkey: payer, lamports: 1447680 }).instructions);
nonceSetup.sign(uploader, nonceKey); assert(nonceSetup.verifySignatures());
const initializeNonce = SystemInstruction.decodeNonceInitialize(nonceSetup.instructions[1]);
assert(initializeNonce.authorizedPubkey.equals(payer));
assert(!nonceSetup.signatures.some(item => item.publicKey.equals(payer)));
const nonceSigned = durableTransaction(signedPayer.publicKey, nonceKey.publicKey, nonceValue,
  [writeBuffer(buffer, signedPayer.publicKey, 0, Buffer.from([1]))]);
const nonceIssued = Transaction.from(nonceSigned.serialize({ requireAllSignatures: false }));
nonceSigned.sign(signedPayer);
assert(nonceSigned.verifySignatures()); assert(sameMessage(nonceSigned, nonceIssued));
const changedNonce = Transaction.from(nonceSigned.serialize()); changedNonce.recentBlockhash = Keypair.generate().publicKey.toBase58();
assert(!sameMessage(changedNonce, nonceIssued)); assert(!changedNonce.verifySignatures());

// Exercise the real wallet wire format: v0 messages are compiled once, preserving
// local co-signatures and account permissions through browser and wallet signing.
const walletPlan = walletTransaction(signedPayer.publicKey, nonceValue, [
  SystemProgram.transfer({ fromPubkey: signedPayer.publicKey, toPubkey: uploader.publicKey, lamports: UPLOAD_FUNDING_LAMPORTS }),
  setBufferAuthority(buffer, signedPayer.publicKey, uploader.publicKey)]);
const walletReply = VersionedTransaction.deserialize(walletPlan.serialize());
const walletInstructions = TransactionMessage.decompile(walletPlan.message).instructions;
assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(walletInstructions[0]).units, 1_400_000);
assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(walletInstructions[1]).microLamports, 0n);
assert.equal(walletInstructions.length, 4);
assert.throws(() => signedWalletTransaction(walletReply.serialize(), walletPlan), { message: "wallet_signature_missing" });
walletReply.sign([signedPayer]);
assert(signedWalletTransaction(walletReply.serialize(), walletPlan).message.serialize().every((b, i) => b === walletPlan.message.serialize()[i]));
const corrupt = VersionedTransaction.deserialize(walletReply.serialize()); corrupt.signatures[0][0] ^= 1;
assert.throws(() => signedWalletTransaction(corrupt.serialize(), walletPlan), { message: "wallet_signature_invalid" });
const altered = VersionedTransaction.deserialize(walletReply.serialize()); altered.message.recentBlockhash = buffer.toBase58();
altered.sign([signedPayer]);
assert.throws(() => signedWalletTransaction(altered.serialize(), walletPlan), { message: "wallet_changed_message" });
assert.equal(walletMessageDifference(altered.serialize(), walletPlan).blockhashChanged, true);
const changedAmount = VersionedTransaction.deserialize(walletReply.serialize()); changedAmount.message.compiledInstructions[2].data[4] ^= 1;
changedAmount.sign([signedPayer]);
assert.throws(() => signedWalletTransaction(changedAmount.serialize(), walletPlan), { message: "wallet_changed_message" });
assert.equal(walletMessageDifference(changedAmount.serialize(), walletPlan).instructionsChanged, true);
const cosigner = Keypair.generate();
const finalPlan = walletTransaction(signedPayer.publicKey, nonceValue, [
  SystemProgram.nonceAdvance({ noncePubkey: nonceKey.publicKey, authorizedPubkey: signedPayer.publicKey }),
  SystemProgram.createAccount({ fromPubkey: signedPayer.publicKey, newAccountPubkey: cosigner.publicKey,
    lamports: 833120, space: 36, programId: LOADER })], [cosigner]);
const finalReply = VersionedTransaction.deserialize(finalPlan.serialize()); finalReply.sign([signedPayer]);
const finalInstructions = TransactionMessage.decompile(finalPlan.message).instructions;
assert.equal(SystemInstruction.decodeInstructionType(finalInstructions[0]), "AdvanceNonceAccount");
assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(finalInstructions[1]).units, 1_400_000);
assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitPrice(finalInstructions[2]).microLamports, 0n);
const withBudget = walletTransaction(signedPayer.publicKey, nonceValue, [
  ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000_000 }), ...walletInstructions.slice(2)]);
const withBudgetInstructions = TransactionMessage.decompile(withBudget.message).instructions;
assert.equal(withBudgetInstructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 2).length, 1);
assert.equal(withBudgetInstructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === 3).length, 1);
assert.equal(ComputeBudgetInstruction.decodeSetComputeUnitLimit(withBudgetInstructions[1]).units, 1_000_000);
assert.doesNotThrow(() => signedWalletTransaction(finalReply.serialize(), finalPlan));
assert(finalReply.signatures[1].every((b, i) => b === finalPlan.signatures[1][i]));
finalReply.signatures[1].fill(0);
assert.throws(() => signedWalletTransaction(finalReply.serialize(), finalPlan), { message: "wallet_signature_missing" });
assert.deepEqual(walletMessageDifference(Buffer.from([1, 2]), walletPlan), { malformedTransaction: true });
const browser = vm.createContext({ console, TextEncoder, TextDecoder, crypto: webcrypto, setTimeout, clearTimeout });
vm.runInContext(await readFile(new URL("./index.iife.min.js", import.meta.resolve("@solana/web3.js")), "utf8"), browser);
browser.wire = Array.from(walletPlan.serialize()); browser.secret = Array.from(signedPayer.secretKey);
vm.runInContext("const parsed = solanaWeb3.VersionedTransaction.deserialize(Uint8Array.from(wire)); parsed.sign([solanaWeb3.Keypair.fromSecretKey(Uint8Array.from(secret))]); result = Array.from(parsed.serialize());", browser);
assert.doesNotThrow(() => signedWalletTransaction(Uint8Array.from(browser.result), walletPlan));

for (const count of [64, 128]) for (const threshold of [0n, 2n ** 31n, 2n ** 32n]) {
  const request = requestProbe(config, 99n, count, count - 1, threshold, Buffer.alloc(32, 9));
  assert.equal(request.instruction.data.length, 60); assert.equal(request.instruction.keys.length, 7);
  assert.equal(request.instruction.data.readBigUInt64LE(8), 99n);
  const locked = { nonce: "99", count, target: count - 1, threshold: threshold.toString(), bump: request.bump, attempt: request.attempt.toBase58() };
  const bytes = Buffer.alloc(117); discriminator("account:Attempt").copy(bytes); payer.toBuffer().copy(bytes, 8);
  bytes.writeBigUInt64LE(99n, 40); bytes.writeUInt16LE(count, 48); bytes.writeUInt16LE(count - 1, 50);
  bytes.writeBigUInt64LE(threshold, 52); bytes.writeBigUInt64LE(10n, 60); bytes[116] = request.bump;
  const account = { owner: program, data: bytes }; assert.equal(decodeAttempt(account, config, locked).status, "pending");
  bytes.writeBigUInt64LE(11n, 68); bytes.writeUInt32LE(2147483648, 76); bytes.writeUInt32LE(179, 80);
  bytes.writeUInt32LE(2147483648, 108); bytes.writeUInt16LE(179 % count, 112); bytes[114] = Number(2147483648n < threshold); bytes[115] = 1;
  const result = decodeAttempt(account, config, locked);
  assert.equal(result.success, 2147483648n < threshold);
  assert.equal(result.sampledBox, 179 % count);
  assert.throws(() => decodeAttempt({ owner: LOADER, data: bytes }, config, locked));
  assert.throws(() => decodeAttempt(account, config, { ...locked, nonce: "100" }));
  bytes[108] ^= 1; assert.throws(() => decodeAttempt(account, config, locked)); bytes[108] ^= 1;
  const [scoped] = PublicKey.findProgramAddressSync([Buffer.from("identity"), program.toBuffer()], new PublicKey(config.vrfProgram));
  const consume = Buffer.concat([discriminator("global:consume_probe"), Buffer.from(result.randomness, "hex"), u64(locked.nonce)]);
  function base58(value) { const a = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"; let n = BigInt("0x" + value.toString("hex")), text = ""; while (n) { text = a[Number(n % 58n)] + text; n /= 58n; } return "1".repeat(value.findIndex(x => x !== 0) < 0 ? value.length : value.findIndex(x => x !== 0)) + text; }
  assert(decodeBase58(base58(consume)).equals(consume)); assert(decodeBase58("111").equals(Buffer.alloc(3)));
  const parsed = { transaction: { message: { instructions: [{ programId: new PublicKey(config.vrfProgram) }] } },
    meta: { err: null, innerInstructions: [{ instructions: [{ programId: program, accounts: [scoped, request.attempt], data: base58(consume) }] }] } };
  assert(matchesCallback(parsed, config, locked, result));
  parsed.meta.err = { InstructionError: [0, "bad"] }; assert(!matchesCallback(parsed, config, locked, result)); parsed.meta.err = null;
  parsed.meta.innerInstructions[0].instructions[0].accounts[0] = payer; assert(!matchesCallback(parsed, config, locked, result));
  parsed.meta.innerInstructions[0].instructions[0].accounts[0] = scoped;
  assert(!matchesCallback(parsed, config, { ...locked, nonce: "100" }, result));
  parsed.transaction.message.instructions = []; assert(!matchesCallback(parsed, config, locked, result));
}
assert.throws(() => requestProbe(config, 1n, 65, 0, 1n, Buffer.alloc(32)));
assert.throws(() => requestProbe(config, 1n, 64, 64, 1n, Buffer.alloc(32)));
assert.throws(() => requestProbe(config, 1n, 64, 0, 2n ** 32n + 1n, Buffer.alloc(32)));

// Periodic attestation keeps owner, address, authority and deployment-slot
// checks, but re-downloads code only on first verification or a slot change.
const codeBinary = Buffer.alloc(128, 7), programBytes = Buffer.alloc(36), programDataBytes = Buffer.alloc(45 + 160);
const [programDataAddress] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER);
programBytes.writeUInt32LE(2); programDataAddress.toBuffer().copy(programBytes, 4);
programDataBytes.writeUInt32LE(3); programDataBytes.writeBigUInt64LE(100n, 4); programDataBytes[12] = 1;
payer.toBuffer().copy(programDataBytes, 13); codeBinary.copy(programDataBytes, 45);
let clock = 0, metadataReads = 0, binaryReads = 0;
const deploymentConnection = {
  getMultipleAccountsInfoAndContext: async (addresses, options) => {
    metadataReads++; assert(addresses[1].equals(programDataAddress)); assert.deepEqual(options.dataSlice, { offset: 0, length: 45 });
    return { context: { slot: 200 }, value: [{ owner: LOADER, executable: true, data: programBytes },
      { owner: LOADER, data: Buffer.from(programDataBytes.subarray(0, 45)) }] };
  },
  getAccountInfo: async (_address, options) => { binaryReads++; assert.equal(options.minContextSlot, 200); return { owner: LOADER, data: Buffer.from(programDataBytes) }; },
};
const verifyProgram = createDeploymentVerifier({ connection: deploymentConnection, program, authority: payer, binary: codeBinary, now: () => clock });
const checkA = verifyProgram(), checkB = verifyProgram(); assert.equal(checkA, checkB);
assert.equal(await checkA, true); assert.equal(metadataReads, 1); assert.equal(binaryReads, 1);
await verifyProgram(); assert.equal(metadataReads, 1);
clock = 30001; assert.equal(await verifyProgram(), true); assert.equal(metadataReads, 2); assert.equal(binaryReads, 1);
clock = 60002; programDataBytes.writeBigUInt64LE(101n, 4);
assert.equal(await verifyProgram(), true); assert.equal(binaryReads, 2, "A loader slot change requires full code verification");
clock = 90003; programDataBytes.writeBigUInt64LE(102n, 4); programDataBytes[45] ^= 1;
await assert.rejects(verifyProgram(), /deployed_binary_or_authority_mismatch/);
programDataBytes[45] ^= 1; buffer.toBuffer().copy(programDataBytes, 13);
await assert.rejects(verifyProgram(), /deployed_binary_or_authority_mismatch/);
payer.toBuffer().copy(programDataBytes, 13);
const legacyProgram = createDeploymentVerifier({ connection: deploymentConnection, program, authority: payer, binary: Buffer.alloc(130, 9),
  previous: { bytes: codeBinary.length, sha256: createHash("sha256").update(codeBinary).digest("hex") }, now: () => clock });
assert.equal(await legacyProgram(), false, "The accepted previous binary still requires an upgrade");
console.log("PASS: loader encoding, resumable chunks, bounded uploader authority, wallet-owned nonce setup, delayed-signing lifetime and replay checks, signed-message binding, strict results and matching callbacks.");
