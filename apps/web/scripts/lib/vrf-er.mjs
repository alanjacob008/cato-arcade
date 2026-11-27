import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { discriminator, requestProbe, decodeAttempt, SPONSOR_REQUESTS, MAX_SPONSORED_REQUESTS } from "./vrf-deployment.mjs";

// Pinned devnet Asia validator. Never accept an RPC or validator from the browser.
export const ER_ENDPOINT = "https://devnet-as.magicblock.app";
export const ER_VALIDATOR = new PublicKey("MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57");
export const ER_QUEUE = new PublicKey("5hBR571xnXppuCPveTrctfTU7tJLSN94nq7kv7FRK5Tc");
export const DELEGATION_PROGRAM = new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh");
export const MAGIC_PROGRAM = new PublicKey("Magic11111111111111111111111111111111111111");
export const MAGIC_CONTEXT = new PublicKey("MagicContext1111111111111111111111111111111");
export const ER_FUNDING = 5_000_000;
// A returned, partly used session needs a new allowance before re-delegation.
export function erSessionPhase(state, nowSeconds = Date.now() / 1000) {
  return state.remaining === SPONSOR_REQUESTS && state.expiresAt > nowSeconds ? "delegate" : "renew";
}
const meta = (pubkey, isWritable = false, isSigner = false) => ({ pubkey, isWritable, isSigner });
export function erAddress(config, delegate) {
  return PublicKey.findProgramAddressSync([Buffer.from("er-session"), new PublicKey(config.adminAuthority).toBuffer(), delegate.toBuffer()], new PublicKey(config.vrfProbeProgram));
}
export function erDelegationAddresses(config, delegate) {
  const [session] = erAddress(config, delegate), program = new PublicKey(config.vrfProbeProgram);
  return { session, buffer: PublicKey.findProgramAddressSync([Buffer.from("buffer"), session.toBuffer()], program)[0],
    record: PublicKey.findProgramAddressSync([Buffer.from("delegation"), session.toBuffer()], DELEGATION_PROGRAM)[0],
    metadata: PublicKey.findProgramAddressSync([Buffer.from("delegation-metadata"), session.toBuffer()], DELEGATION_PROGRAM)[0] };
}
export function initializeErSession(config, delegate, expiresAt, renew = false) {
  const expiry = Buffer.alloc(8); expiry.writeBigInt64LE(BigInt(expiresAt));
  const quota = Buffer.alloc(2); quota.writeUInt16LE(SPONSOR_REQUESTS);
  return new TransactionInstruction({ programId: new PublicKey(config.vrfProbeProgram),
    keys: [meta(new PublicKey(config.adminAuthority), !renew, true), meta(erAddress(config, delegate)[0], true), ...(!renew ? [meta(SystemProgram.programId)] : [])],
    data: Buffer.concat([discriminator(`global:${renew ? "renew_er_session" : "initialize_er_session"}`),
      ...(!renew ? [delegate.toBuffer(), ER_VALIDATOR.toBuffer()] : []), expiry, quota]) });
}
export function delegateErSession(config, delegate) {
  const p = erDelegationAddresses(config, delegate);
  return new TransactionInstruction({ programId: new PublicKey(config.vrfProbeProgram),
    keys: [meta(new PublicKey(config.adminAuthority), true, true), meta(p.buffer, true), meta(p.record, true), meta(p.metadata, true),
      meta(p.session, true), meta(ER_VALIDATOR), meta(new PublicKey(config.vrfProbeProgram)), meta(DELEGATION_PROGRAM), meta(SystemProgram.programId)],
    data: Buffer.concat([discriminator("global:delegate_er_session"), delegate.toBuffer()]) });
}
export function undelegateErSession(config, delegate) {
  return new TransactionInstruction({ programId: new PublicKey(config.vrfProbeProgram),
    keys: [meta(delegate, true, true), meta(erAddress(config, delegate)[0], true), meta(MAGIC_PROGRAM), meta(MAGIC_CONTEXT, true)],
    data: discriminator("global:undelegate_er_session") });
}
export function requestErProbe(config, delegate, ...args) {
  const request = requestProbe({ ...config, adminAuthority: delegate.toBase58(), vrfQueue: ER_QUEUE.toBase58() }, ...args);
  const [attempt, bump] = erAddress(config, delegate);
  request.instruction.keys[1] = meta(attempt, true);
  discriminator("global:request_er_probe").copy(request.instruction.data);
  return { instruction: request.instruction, attempt, bump };
}
export function decodeErSession(account, config, delegate, addressFactory = erAddress) {
  if (!account) return null;
  const b = account.data;
  if (!account.owner.equals(new PublicKey(config.vrfProbeProgram)) || b.length !== 233
    || !b.subarray(0, 8).equals(discriminator("account:ErSession"))
    || !b.subarray(8, 40).equals(new PublicKey(config.adminAuthority).toBuffer()) || !b.subarray(40, 72).equals(delegate.toBuffer())
    || !b.subarray(72, 104).equals(ER_VALIDATOR.toBuffer()) || b[123] !== addressFactory(config, delegate)[1]
    || b.readUInt16LE(112) > MAX_SPONSORED_REQUESTS || ![0, 1].includes(b[122]) || ![0, 1].includes(b[231])
    || !b.subarray(124, 156).equals(delegate.toBuffer()) || b[232] !== b[123]
    || (!b[122] && (b.readBigUInt64LE(114) !== 0n || b[231] !== 1))
    || (b[122] && b.readBigUInt64LE(114) !== b.readBigUInt64LE(156) + 1n)) throw Error("er_session_mismatch");
  return { expiresAt: Number(b.readBigInt64LE(104)), remaining: b.readUInt16LE(112), nextNonce: b.readBigUInt64LE(114).toString(),
    hasAttempt: !!b[122], pending: !!b[122] && b[231] === 0 };
}
export function decodeErAttempt(account, config, locked) {
  const delegate = new PublicKey(locked.requestAuthority), state = decodeErSession(account, config, delegate);
  if (!state || !state.hasAttempt || BigInt(state.nextNonce) <= BigInt(locked.nonce)) return null;
  if (BigInt(state.nextNonce) !== BigInt(locked.nonce) + 1n || erAddress(config, delegate)[0].toBase58() !== locked.attempt) throw Error("er_attempt_mismatch");
  return decodeAttempt({ ...account, data: Buffer.concat([discriminator("account:Attempt"), account.data.subarray(124)]) }, config, locked);
}
export function checkErDelegation(account, config) {
  const b = account?.data;
  if (!account?.owner.equals(DELEGATION_PROGRAM) || b?.length !== 96 || b.readBigUInt64LE(0) !== 100n
    || !b.subarray(8, 40).equals(ER_VALIDATOR.toBuffer()) || !b.subarray(40, 72).equals(new PublicKey(config.vrfProbeProgram).toBuffer())) throw Error("er_delegation_mismatch");
  return true;
}
export async function verifyErEndpoint(fetchRpc = fetch) {
  const response = await fetchRpc(ER_ENDPOINT, { method: "POST", signal: AbortSignal.timeout(8000), headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity" }) });
  if (!response.ok || (await response.json()).result?.identity !== ER_VALIDATOR.toBase58()) throw Error("er_validator_mismatch");
  return true;
}
