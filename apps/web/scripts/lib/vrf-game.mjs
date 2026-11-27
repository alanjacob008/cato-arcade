import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import ts from "typescript";

// Load the very same odds/validation used by the rendered claw. Local diagnostic
// only: a browser-supplied pose is not an authoritative paid-game inventory.
export async function loadClawRules() {
  const base = new URL("../../components/claw/", import.meta.url);
  const compile = async name => ts.transpileModule(await readFile(new URL(name, base), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const url = source => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
  const config = url(await compile("config.ts"));
  const withConfig = text => text.replaceAll('"./config"', JSON.stringify(config));
  const pile = url(withConfig(await compile("pile.ts")).replace('"cannon-es"', JSON.stringify(import.meta.resolve("cannon-es"))));
  const daily = url(withConfig(await compile("daily.ts")));
  return { ...await import(url(withConfig(await compile("rewards.ts")).replaceAll('"./pile"', JSON.stringify(pile)).replaceAll('"./daily"', JSON.stringify(daily)))),
    ...await import(daily) };
}

export function gameThreshold(probability) {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw Error("invalid_game_probability");
  // Exactly matches the original u32 / 2^32 < probability comparison.
  return BigInt(Math.ceil(probability * 2 ** 32)).toString();
}

export function createGameService({ session, rules, manifest, prepare, refreshAttempt, save, deployed, requestProbe,
  requestAuthority = manifest.adminAuthority, sendSponsored = null, nextNonce = async () => randomBytes(8).readBigUInt64LE().toString(), now = Date.now, maxAttempts = 1000 }) {
  const fingerprint = pull => createHash("sha256").update(JSON.stringify(pull)).digest("hex");
  const reads = new Map();
  function validate(pull) {
    if (!pull || !/^[a-zA-Z0-9-]{1,100}$/.test(pull.id ?? "")) throw Error("invalid_game_attempt");
    rules.resolvePull(pull, () => 0, "magicblock-vrf");
    const target = Number(pull.target?.box.id?.match(/^BOX-(\d+)$/)?.[1]) - 1;
    if (!pull.target || !Number.isInteger(target) || target < 0 || target >= 64) throw Error("game_target_required");
    return target;
  }
  async function response(locked, refresh = true) {
    if (refresh) await refreshAttempt(locked);
    let result = null;
    if (locked.callbackSignature) {
      result = rules.resolvePull(locked.gamePull, () => locked.result.roll / 2 ** 32, "magicblock-vrf");
      if (result.success !== locked.result.success || gameThreshold(result.probability) !== locked.threshold) throw Error("game_result_mismatch");
    }
    return { gameId: locked.gamePull.id, pending: !result, submitted: !locked.preflightRejected && (!!locked.requestSignature || ["pending", "fulfilled"].includes(locked.result?.status)), result,
      pull: locked.gamePull, requestSignature: locked.requestSignature ?? null, callbackSignature: locked.callbackSignature ?? null,
      sponsorError: locked.sponsorError ?? null,
      timings: { preparationStartedAt: locked.preparationStartedAt ?? locked.lockedAt, lockedAt: locked.lockedAt, submittedAt: locked.submittedAt ?? null, confirmedAt: locked.confirmedAt ?? null,
        durableReadyAt:locked.durableReadyAt??null,broadcastAt:locked.broadcastAt??null,
        callbackVerifiedAt: locked.callbackVerifiedAt ?? null, requestedSlot: locked.result?.requestedSlot ?? null,
        fulfilledSlot: locked.result?.fulfilledSlot ?? null } };
  }
  return {
    async plan(pull) {
      const preparationStartedAt = now();
      const target = validate(pull);
      if (!await deployed()) throw Error("program_not_deployed");
      let locked = session.attempts.find(attempt => attempt.gamePull?.id === pull.id);
      const fresh = !locked;
      if (locked && locked.gameFingerprint !== fingerprint(pull)) throw Error("game_attempt_inputs_changed");
      if (!locked) {
        const previous = session.attempts.at(-1);
        if (previous && !previous.callbackSignature) {
          await refreshAttempt(previous);
          if (!previous.callbackSignature) throw Error("previous_callback_pending_check_status");
        }
        if (session.attempts.length >= maxAttempts) throw Error("devnet_attempt_limit_reached");
        const nonce = await nextNonce(), seed = randomBytes(32);
        const threshold = gameThreshold(pull.target.probability);
        const request = requestProbe(manifest, nonce, 64, target, threshold, seed);
        locked = { nonce, count: 64, target, threshold, seed: seed.toString("hex"),
          attempt: request.attempt.toBase58(), bump: request.bump, gamePull: JSON.parse(JSON.stringify(pull)),
          gameFingerprint: fingerprint(pull), preparationStartedAt, lockedAt: now(), requestAuthority, result: { status: "not_submitted" } };
        session.attempts.push(locked); await save();
      }
      const state = await response(locked, !fresh);
      if (state.result || state.submitted) return { ...state, done: !!state.result };
      if (sendSponsored) {
        if (locked.requestAuthority !== requestAuthority) throw Error("legacy_attempt_requires_admin_recovery");
        await sendSponsored(locked);
        // Return the durable broadcast receipt immediately. The shared reader
        // and confirmed push notifications verify the callback concurrently.
        return { ...await response(locked, false), sponsored: true };
      }
      const request = requestProbe(manifest, locked.nonce, locked.count, locked.target, locked.threshold, Buffer.from(locked.seed, "hex"));
      return { ...await prepare([[request.instruction]], [], "Request one locked devnet claw result. This spends devnet SOL only; test prizes cannot be withdrawn.", "game", locked, true), gameId: pull.id };
    },
    state(id) {
      const locked = id ? session.attempts.find(attempt => attempt.gamePull?.id === id) : session.attempts.findLast(attempt => attempt.gamePull);
      if (!locked) return Promise.resolve({ pending: false, submitted: false, result: null, notFound: true });
      if (!reads.has(id)) reads.set(id, (async () => {
        let current = await response(locked);
        if (sendSponsored && !current.result && locked.sponsorWire && !locked.confirmedAt && !locked.preflightRejected
          && now() - (locked.lastBroadcastAt ?? 0) >= 5000) {
          try { await sendSponsored(locked); } catch { /* Keep exact pending attempt and report sponsorError. */ }
          current = await response(locked);
        }
        return current;
      })().finally(() => reads.delete(id)));
      return reads.get(id);
    },
    async recordTiming(id, events) {
      const locked = session.attempts.find(attempt => attempt.gamePull?.id === id);
      if (!locked?.callbackSignature) throw Error("verified_game_result_required");
      if (!events || typeof events !== "object" || Array.isArray(events)) throw Error("invalid_presentation_timing");
      const allowed = ["pressed", "inserting", "descending", "grabbing", "waiting", "lifting", "delivering", "finished", "started", "wallet-prompt", "wallet-approved", "request-confirmed", "result-ready", "recovery-started"];
      const accepted = {};
      for (const key of allowed) if (events[key] !== undefined) {
        if (!Number.isSafeInteger(events[key]) || events[key] < now() - 86400000 || events[key] > now() + 5000) throw Error("invalid_presentation_timing");
        accepted[key] = events[key];
      }
      if (!accepted.finished || Object.values(accepted).some(time => time > accepted.finished)) throw Error("invalid_presentation_timing");
      // Client-reported presentation measurements are never used for odds,
      // settlement or VRF verification.
      locked.presentationTiming = accepted; await save(); return { saved: true };
    },
  };
}
