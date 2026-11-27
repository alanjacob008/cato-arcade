import { PublicKey } from "@solana/web3.js";
import { decodeAttempt, matchesCallback } from "./vrf-deployment.mjs";

// Push messages supply only a receipt hint. Both the confirmed account and the
// actual callback transaction must still pass the original verification rules.
export function createAttemptReader({ connection, manifest, save, hints = () => [], decode = decodeAttempt, callback = matchesCallback, now = Date.now }) {
  const reads = new Map();
  const dirty = new WeakSet();
  const observed = locked => JSON.stringify([locked.attemptObserved,locked.result,locked.requestSignature,
    locked.failedRequestSignature,locked.confirmedAt,locked.callbackSignature,locked.callbackVerifiedAt]);
  async function persist(locked) { await save(); dirty.delete(locked); }
  async function read(locked) {
    if (locked.callbackSignature) { if(dirty.has(locked))await persist(locked);return locked; }
    const before=observed(locked);
    const hint = hints(locked).at(-1);
    const [account, hintedTx] = await Promise.all([
      connection.getAccountInfo(new PublicKey(locked.attempt), hint
        ? { commitment: "confirmed", minContextSlot: hint.slot } : "confirmed"),
      hint ? connection.getParsedTransaction(hint.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" }) : null,
    ]);
    const result = account ? decode(account, manifest, locked) : null;
    locked.attemptObserved = !!result;
    if (!result) {
      if (locked.requestSignature) {
        const receipt = (await connection.getSignatureStatuses([locked.requestSignature], { searchTransactionHistory: true })).value[0];
        if (receipt?.err) { locked.failedRequestSignature = locked.requestSignature; delete locked.requestSignature; }
      }
      locked.result = { status: locked.requestSignature ? "pending" : "not_submitted" };
      if(observed(locked)!==before)dirty.add(locked);
      if(dirty.has(locked))await persist(locked);
      return locked;
    }
    if (locked.requestSignature) locked.confirmedAt ??= now();
    if (result.status === "fulfilled") {
      if (hint && callback(hintedTx, manifest, locked, result)) locked.callbackSignature = hint.signature;
      else {
        const receipts = await connection.getSignaturesForAddress(new PublicKey(locked.attempt), { limit: 10 });
        for (const receipt of receipts.filter(item => !item.err && item.signature !== locked.requestSignature)) {
          const tx = await connection.getParsedTransaction(receipt.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
          if (callback(tx, manifest, locked, result)) { locked.callbackSignature = receipt.signature; break; }
        }
      }
      if (locked.callbackSignature) locked.callbackVerifiedAt = now();
    }
    locked.result = result;
    if(observed(locked)!==before)dirty.add(locked);
    if(dirty.has(locked))await persist(locked);
    return locked;
  }
  return locked => {
    const key = [locked.requestAuthority ?? manifest.adminAuthority, locked.attempt, locked.nonce].join(":");
    if (!reads.has(key)) reads.set(key, read(locked).finally(() => reads.delete(key)));
    return reads.get(key);
  };
}
