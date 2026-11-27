import { VersionedTransaction, SendTransactionError } from "@solana/web3.js";
import { sponsorAddress, decodeSponsor, requestSponsoredProbe, walletTransaction } from "./vrf-deployment.mjs";
import { safeRpcError } from "./vrf-rpc-transport.mjs";

export function encodeSignature(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt(`0x${Buffer.from(bytes).toString("hex")}`), result = "";
  while (n) { result = alphabet[Number(n % 58n)] + result; n /= 58n; }
  let zeros = 0; while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  return "1".repeat(zeros) + result;
}

// A saved request is released only when it provably never landed: its blockhash expired by
// the finalized block height (or it failed onchain), and an attempt read started after that
// observation finds no consumer attempt for its nonce. Any landing block is finalized by then.
// The dead signature moves to failedRequestSignature and the signed bytes are dropped; nonce,
// seed, target, threshold and lane stay, so only the identical request can be signed again.
export async function releaseDeadRequest({ connection, refreshAttempt, save }, locked) {
  if (!locked.sponsorWire || !locked.requestSignature || !locked.sponsorBlock) return false;
  const receipt = (await connection.getSignatureStatuses([locked.requestSignature], { searchTransactionHistory: true })).value[0];
  if (!receipt?.err && await connection.getBlockHeight("finalized") <= locked.sponsorBlock.lastValidBlockHeight) return false;
  // The reader shares in-flight reads; the second call starts after this observation.
  await refreshAttempt(locked); await refreshAttempt(locked);
  if (locked.attemptObserved || locked.result?.status === "fulfilled" || locked.callbackSignature) return false;
  if (locked.requestSignature) { locked.failedRequestSignature = locked.requestSignature; delete locked.requestSignature; }
  delete locked.sponsorWire; locked.result = { status: "not_submitted" };
  await save();
  return true;
}

// Only creates this consumer's fixed sponsored request. There is no arbitrary
// instruction signing API. The key is separate from wallet/upgrade signers.
export function createSponsoredSender({ connection, key, manifest, save, refreshAttempt, permitState = null,
  requestFactory = requestSponsoredProbe, now = Date.now }) {
  const inflight = new Map();
  return async locked => {
    if (inflight.has(locked.nonce)) return inflight.get(locked.nonce);
    const task = (async () => {
      if (locked.requestAuthority !== key.publicKey.toBase58()) throw Error("sponsor_authority_mismatch");
      if (locked.result?.status !== "not_submitted" || locked.requestSignature || locked.sponsorWire) await refreshAttempt(locked);
      // A saved signature only means the send was attempted. Until the account
      // is observed onchain, an RPC timeout must still allow identical-byte
      // rebroadcasts. Never replace an already-created consumer attempt.
      if (locked.attemptObserved || locked.result?.status === "fulfilled") return;
      // Before the permit gate: a dead request must not keep its lane looking in flight while the
      // lane has no capacity (e.g. rejected at preflight at policy expiry), or the lane can never
      // be returned and renewed. The PDA nonce still prevents duplicate outcomes.
      await releaseDeadRequest({ connection, refreshAttempt, save }, locked);
      if (locked.attemptObserved || locked.result?.status === "fulfilled") return;
      const [authorization, block] = await Promise.all([
        permitState ? permitState() : connection.getMultipleAccountsInfo([sponsorAddress(manifest, key.publicKey)[0], key.publicKey]),
        locked.sponsorWire ? null : connection.getLatestBlockhash(),
      ]);
      const [permitAccount, funds] = permitState ? [] : authorization;
      const permit = permitState ? authorization : decodeSponsor(permitAccount, manifest, key.publicKey);
      if (!permit || permit.remaining < 1 || permit.expiresAt <= Math.floor(now() / 1000)) throw Error("sponsor_setup_required");
      if (!permitState && (funds?.lamports ?? 0) < 3_000_000) throw Error("sponsor_budget_low");
      if (locked.sponsorWire && !locked.requestSignature && locked.failedRequestSignature) delete locked.sponsorWire;
      if (!locked.sponsorWire) {
        const request = requestFactory(manifest, key.publicKey, locked.nonce, locked.count, locked.target,
          locked.threshold, Buffer.from(locked.seed, "hex"));
        const signingBlock = block ?? await connection.getLatestBlockhash();
        const tx = walletTransaction(key.publicKey, signingBlock.blockhash, [request.instruction], [key]);
        locked.sponsorWire = Buffer.from(tx.serialize()).toString("base64"); locked.sponsorBlock = signingBlock;
        locked.requestSignature = encodeSignature(tx.signatures[0]);
      }
      locked.sponsorError = null; locked.preflightRejected = false; locked.submittedAt ??= now(); locked.lastBroadcastAt = now();
      // Save the exact signed bytes/signature before contacting the RPC. An
      // ambiguous timeout can only rebroadcast this same signed transaction.
      await save();
      locked.durableReadyAt=now();
      const tx = VersionedTransaction.deserialize(Buffer.from(locked.sponsorWire, "base64"));
      const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
      if (signature !== locked.requestSignature) throw Error("sponsor_receipt_mismatch");
      // Broadcast acknowledgement is not confirmation. Start watching the
      // confirmed consumer account immediately instead of first waiting for a
      // separate signature-status loop, then starting callback detection.
      locked.broadcastAt = now(); await save();
    })().catch(async error => {
      locked.sponsorError = safeRpcError(error);
      if (error instanceof SendTransactionError && error.message.startsWith("Simulation failed.")) locked.preflightRejected = true;
      await save(); throw error;
    })
      .finally(() => inflight.delete(locked.nonce));
    inflight.set(locked.nonce, task); return task;
  };
}
