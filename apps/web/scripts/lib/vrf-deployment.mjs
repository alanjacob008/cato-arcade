import { createHash, timingSafeEqual, createPublicKey, verify } from "node:crypto";
import { PublicKey, SystemProgram, Transaction, TransactionInstruction, NonceAccount, NONCE_ACCOUNT_LENGTH,
  VersionedTransaction, TransactionMessage, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY, SYSVAR_CLOCK_PUBKEY, SYSVAR_SLOT_HASHES_PUBKEY } from "@solana/web3.js";

export const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
export const CHUNK_BYTES = 900;
export const BATCH_SIZE = 8;
export const UPLOAD_FUNDING_LAMPORTS = 7_000_000;
export const discriminator = name => createHash("sha256").update(name).digest().subarray(0, 8);
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }
export function u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; }

export function initializeBuffer(buffer, authority) {
  return new TransactionInstruction({ programId: LOADER, keys: [meta(buffer, true), meta(authority)], data: u32(0) });
}

export function writeBuffer(buffer, authority, offset, bytes) {
  if (!Number.isSafeInteger(offset) || offset < 0 || bytes.length < 1 || bytes.length > CHUNK_BYTES) throw Error("invalid_chunk");
  return new TransactionInstruction({ programId: LOADER, keys: [meta(buffer, true), meta(authority, false, true)],
    data: Buffer.concat([u32(1), u32(offset), u64(bytes.length), bytes]) });
}

export function setBufferAuthority(buffer, current, next) {
  return new TransactionInstruction({ programId: LOADER,
    keys: [meta(buffer, true), meta(current, false, true), meta(next)], data: u32(4) });
}

export function readDurableNonce(account, authority) {
  if (!account?.owner.equals(SystemProgram.programId) || account.data.length !== NONCE_ACCOUNT_LENGTH
    || account.data.readUInt32LE(4) !== 1) throw Error("unexpected_nonce_account");
  const nonce = NonceAccount.fromAccountData(account.data);
  if (!nonce.authorizedPubkey.equals(authority)) throw Error("nonce_authority_mismatch");
  return nonce.nonce;
}

export function durableTransaction(payer, nonceAddress, nonce, instructions) {
  return new Transaction({ feePayer: payer, recentBlockhash: nonce }).add(
    SystemProgram.nonceAdvance({ noncePubkey: nonceAddress, authorizedPubkey: payer }), ...instructions);
}

export function checkSigningLifetime(plan, currentNonce, currentBlockHeight) {
  if (plan.nonce) {
    if (currentNonce !== plan.nonce.value) throw Error("nonce_consumed_refresh_same_step");
  } else if (currentBlockHeight > plan.block.lastValidBlockHeight) throw Error("blockhash_expired_retry_same_step");
}

export function deployProgram(payer, program, buffer, bytes) {
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER);
  return new TransactionInstruction({ programId: LOADER, keys: [meta(payer, true, true), meta(programData, true),
    meta(program, true), meta(buffer, true), meta(SYSVAR_RENT_PUBKEY), meta(SYSVAR_CLOCK_PUBKEY),
    meta(SystemProgram.programId), meta(payer, false, true)], data: Buffer.concat([u32(2), u64(bytes)]) });
}

export function upgradeProgram(authority, program, buffer) {
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER);
  return new TransactionInstruction({ programId: LOADER, data: u32(3), keys: [meta(programData, true), meta(program, true),
    meta(buffer, true), meta(authority, true), meta(SYSVAR_RENT_PUBKEY), meta(SYSVAR_CLOCK_PUBKEY), meta(authority, false, true)] });
}
export function extendProgram(authority, program, additionalBytes) {
  if (!Number.isInteger(additionalBytes) || additionalBytes < 10240 || additionalBytes > 1048576) throw Error("invalid_program_extension");
  const [programData] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER);
  return new TransactionInstruction({ programId: LOADER, data: Buffer.concat([u32(6), u32(additionalBytes)]),
    keys: [meta(programData, true), meta(program, true), meta(SystemProgram.programId), meta(authority, true, true)] });
}

// Extending ProgramData updates its deployment slot. The loader forbids an
// upgrade in that same slot, including a second instruction in the same tx.
export async function nextProgramUpgrade({ connection, authority, program, buffer, bytes, account,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!account?.owner.equals(LOADER) || account.data.length < 45 || account.data.readUInt32LE(0) !== 3
    || account.data[12] !== 1 || !account.data.subarray(13, 45).equals(authority.toBuffer())) throw Error("unexpected_programdata_account");
  if (!Number.isSafeInteger(bytes) || bytes < 1) throw Error("invalid_program_size");
  const changedSlot = account.data.readBigUInt64LE(4);
  let later = false;
  for (let tries = 0; tries < 20; tries++) {
    if (BigInt(await connection.getSlot("confirmed")) > changedSlot) { later = true; break; }
    await sleep(250);
  }
  if (!later) throw Error("program_slot_pending_retry_same_step");
  const extra = Math.max(0, bytes - (account.data.length - 45));
  return extra ? { kind: "extend", instruction: extendProgram(authority, program, Math.max(10240, Math.ceil(extra / 10240) * 10240)) }
    : { kind: "upgrade", instruction: upgradeProgram(authority, program, buffer) };
}

export const MAX_SPONSORED_REQUESTS = 500;
export const SPONSOR_REQUESTS = MAX_SPONSORED_REQUESTS, SPONSOR_SECONDS = 6 * 3600, SPONSOR_FUNDING = 50_000_000;
export function sponsorAddress(config, delegate) {
  return PublicKey.findProgramAddressSync([Buffer.from("sponsor"), new PublicKey(config.adminAuthority).toBuffer(), delegate.toBuffer()], new PublicKey(config.vrfProbeProgram));
}
export function grantSponsor(config, delegate, expires, renew = false) {
  const admin = new PublicKey(config.adminAuthority), [address] = sponsorAddress(config, delegate);
  const quota = Buffer.alloc(2); quota.writeUInt16LE(SPONSOR_REQUESTS);
  const expiry = Buffer.alloc(8); expiry.writeBigInt64LE(BigInt(expires));
  return new TransactionInstruction({ programId: new PublicKey(config.vrfProbeProgram),
    keys: [meta(admin, !renew, true), meta(address, true), ...(!renew ? [meta(SystemProgram.programId)] : [])],
    data: Buffer.concat([discriminator(`global:${renew ? "renew_sponsor" : "grant_sponsor"}`), ...(!renew ? [delegate.toBuffer()] : []), expiry, quota]) });
}
export function revokeSponsor(config, delegate) {
  return new TransactionInstruction({ programId: new PublicKey(config.vrfProbeProgram), data: discriminator("global:revoke_sponsor"),
    keys: [meta(new PublicKey(config.adminAuthority), false, true), meta(sponsorAddress(config, delegate)[0], true)] });
}
export function decodeSponsor(account, config, delegate) {
  if (!account) return null;
  const b = account.data;
  if (!account.owner.equals(new PublicKey(config.vrfProbeProgram)) || b.length !== 83
    || !b.subarray(0, 8).equals(discriminator("account:SponsorSession"))
    || !b.subarray(8, 40).equals(new PublicKey(config.adminAuthority).toBuffer())
    || !b.subarray(40, 72).equals(delegate.toBuffer()) || b[82] !== sponsorAddress(config, delegate)[1]
    || b.readUInt16LE(80) > MAX_SPONSORED_REQUESTS) throw Error("sponsor_account_mismatch");
  return { expiresAt: Number(b.readBigInt64LE(72)), remaining: b.readUInt16LE(80) };
}
export function requestSponsoredProbe(config, delegate, nonce, count, target, threshold, seed) {
  const request = requestProbe({ ...config, adminAuthority: delegate.toBase58() }, nonce, count, target, threshold, seed);
  request.instruction.keys.splice(2, 0, meta(sponsorAddress(config, delegate)[0], true));
  discriminator("global:request_sponsored_probe").copy(request.instruction.data, 0);
  return request;
}

export function missingChunks(bufferData, binary, authority) {
  if (bufferData.length !== 37 + binary.length || bufferData.readUInt32LE(0) !== 1
    || bufferData[4] !== 1 || !bufferData.subarray(5, 37).equals(authority.toBuffer())) throw Error("unexpected_buffer");
  const missing = [];
  for (let offset = 0; offset < binary.length; offset += CHUNK_BYTES) {
    const bytes = binary.subarray(offset, offset + CHUNK_BYTES);
    if (!bufferData.subarray(37 + offset, 37 + offset + bytes.length).equals(bytes)) missing.push({ offset, bytes });
  }
  return missing;
}

export function requestProbe(config, nonce, count, target, threshold, seed) {
  if (![64, 128].includes(count) || !Number.isInteger(target) || target < 0 || target >= count
    || BigInt(threshold) < 0n || BigInt(threshold) > 2n ** 32n || seed.length !== 32) throw Error("invalid_probe");
  const payer = new PublicKey(config.adminAuthority), program = new PublicKey(config.vrfProbeProgram);
  const [attempt, bump] = PublicKey.findProgramAddressSync([Buffer.from("probe"), payer.toBuffer(), u64(nonce)], program);
  const [identity] = PublicKey.findProgramAddressSync([Buffer.from("identity")], program);
  const args = Buffer.alloc(12); args.writeBigUInt64LE(BigInt(nonce)); args.writeUInt16LE(count, 8); args.writeUInt16LE(target, 10);
  const instruction = new TransactionInstruction({ programId: program, keys: [meta(payer, true, true), meta(attempt, true),
    meta(new PublicKey(config.vrfQueue), true), meta(identity), meta(new PublicKey(config.vrfProgram)),
    meta(SYSVAR_SLOT_HASHES_PUBKEY), meta(SystemProgram.programId)],
  data: Buffer.concat([discriminator("global:request_probe"), args, u64(threshold), seed]) });
  return { instruction, attempt, bump };
}

export function decodeAttempt(account, config, locked) {
  const b = account?.data;
  if (!account?.owner.equals(new PublicKey(config.vrfProbeProgram)) || !b || b.length !== 117
    || !b.subarray(0, 8).equals(discriminator("account:Attempt"))
    || !b.subarray(8, 40).equals(new PublicKey(locked.requestAuthority ?? config.adminAuthority).toBuffer())
    || b.readBigUInt64LE(40).toString() !== locked.nonce || b.readUInt16LE(48) !== locked.count
    || b.readUInt16LE(50) !== locked.target || b.readBigUInt64LE(52).toString() !== locked.threshold
    || b[116] !== locked.bump || ![0, 1].includes(b[115])) throw Error("attempt_mismatch");
  if (b[115] === 0) return { status: "pending" };
  const randomness = b.subarray(76, 108), roll = randomness.readUInt32LE(0), sample = randomness.readUInt32LE(4) % locked.count;
  const success = BigInt(roll) < BigInt(locked.threshold);
  if (b.readUInt32LE(108) !== roll || b.readUInt16LE(112) !== sample || b[114] !== Number(success)
    || b.readBigUInt64LE(68) < b.readBigUInt64LE(60)) throw Error("invalid_fulfillment");
  return { status: "fulfilled", randomness: randomness.toString("hex"), roll, sampledBox: sample, success,
    requestedSlot: b.readBigUInt64LE(60).toString(), fulfilledSlot: b.readBigUInt64LE(68).toString() };
}

export function sameMessage(received, issued) {
  const a = received.serializeMessage(), b = issued.serializeMessage();
  return a.length === b.length && timingSafeEqual(a, b);
}

// Compile once before either signer sees the transaction. VersionedTransaction
// preserves those exact message bytes across wallet/browser/server boundaries.
export function walletTransaction(payer, blockhash, instructions, signers = []) {
  // Phantom auto-adds priority fees to unsigned messages without compute-budget
  // instructions. Set these before freezing/signing; never accept wallet edits.
  const budget = instructions.filter(ix => ix.programId.equals(ComputeBudgetProgram.programId));
  const explicit = [];
  if (!budget.some(ix => ix.data[0] === 2)) explicit.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  if (!budget.some(ix => ix.data[0] === 3)) explicit.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 0 }));
  const first = instructions[0];
  const hasNonce = first?.programId.equals(SystemProgram.programId) && first.data.length === 4 && first.data.readUInt32LE(0) === 4;
  const fixed = hasNonce ? [first, ...explicit, ...instructions.slice(1)] : [...explicit, ...instructions];
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash,
    instructions: fixed }).compileToV0Message());
  if (signers.length) tx.sign(signers);
  return tx;
}

export function signedWalletTransaction(bytes, issued) {
  const tx = VersionedTransaction.deserialize(bytes);
  const expected = Buffer.from(issued.message.serialize()), actual = Buffer.from(tx.message.serialize());
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error("wallet_changed_message");
  for (let index = 0; index < tx.message.header.numRequiredSignatures; index++) {
    const signature = tx.signatures[index];
    if (!signature || signature.every(byte => byte === 0)) throw Error("wallet_signature_missing");
    const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"),
      tx.message.staticAccountKeys[index].toBuffer()]), format: "der", type: "spki" });
    if (!verify(null, actual, key, signature)) throw Error("wallet_signature_invalid");
  }
  return tx;
}

export function walletMessageDifference(bytes, issued) {
  try {
    const tx = VersionedTransaction.deserialize(bytes), a = tx.message, b = issued.message;
    return { versionChanged: tx.version !== issued.version,
      blockhashChanged: a.recentBlockhash !== b.recentBlockhash,
      accountsChanged: JSON.stringify(a.staticAccountKeys.map(key => key.toBase58())) !== JSON.stringify(b.staticAccountKeys.map(key => key.toBase58())),
      headerChanged: JSON.stringify(a.header) !== JSON.stringify(b.header),
      instructionsChanged: JSON.stringify(a.compiledInstructions) !== JSON.stringify(b.compiledInstructions),
      lookupsChanged: JSON.stringify(a.addressTableLookups ?? []) !== JSON.stringify(b.addressTableLookups ?? []),
      issuedPrograms: b.compiledInstructions.map(ix => b.staticAccountKeys[ix.programIdIndex].toBase58()),
      returnedPrograms: a.compiledInstructions.map(ix => a.staticAccountKeys[ix.programIdIndex].toBase58()) };
  } catch { return { malformedTransaction: true }; }
}

export function decodeBase58(text) {
  if (text.length > 128) throw Error("invalid_instruction_data");
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of text) { const i = alphabet.indexOf(c); if (i < 0) throw Error("invalid_instruction_data"); n = n * 58n + BigInt(i); }
  const hex = n.toString(16);
  return Buffer.concat([Buffer.alloc(text.match(/^1*/)[0].length), n === 0n ? Buffer.alloc(0) : Buffer.from(hex.padStart(Math.ceil(hex.length / 2) * 2, "0"), "hex")]);
}

export function matchesCallback(tx, config, locked, result, handler = "consume_probe") {
  if (!tx || !tx.meta || tx.meta.err || result.status !== "fulfilled") return false;
  const program = new PublicKey(config.vrfProbeProgram), vrf = new PublicKey(config.vrfProgram);
  const [scoped] = PublicKey.findProgramAddressSync([Buffer.from("identity"), program.toBuffer()], vrf);
  const expected = Buffer.concat([discriminator(`global:${handler}`), Buffer.from(result.randomness, "hex"), u64(locked.nonce)]);
  if (!tx.transaction.message.instructions.some(ix => ix.programId?.equals(vrf))) return false;
  return (tx.meta.innerInstructions ?? []).some(group => group.instructions.some(ix => {
    try { return ix.programId?.equals(program) && ix.accounts?.[0]?.equals(scoped)
      && ix.accounts?.[1]?.toBase58() === locked.attempt && decodeBase58(ix.data).equals(expected); }
    catch { return false; }
  }));
}
