const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// One start-rate budget for the whole connection. Two independent RPCs may be
// in flight together; a slow response no longer blocks unrelated requests.
// SDK-internal retries stay disabled and Retry-After pauses all new starts.
export function pacedRpcFetch({ fetcher = fetch, spacingMs = 220, concurrency = 2, sleep = delay, now = Date.now } = {}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw Error("invalid_rpc_concurrency");
  let gate = Promise.resolve(), nextStart = 0, active = 0;
  const queued = [];
  function drain() {
    while (active < concurrency && queued.length) {
      const { task, resolve, reject } = queued.shift(); active++;
      task().then(resolve, reject).finally(() => { active--; drain(); });
    }
  }
  return (url, init = {}) => {
    const task = async () => {
      for (let attempt = 0; attempt < 4; attempt++) {
        let response;
        try {
          const slot = gate.then(async () => {
            do { await sleep(Math.max(0, nextStart - now())); } while (now() < nextStart);
            nextStart = now() + spacingMs;
            return { response: fetcher(url, { ...init, redirect: "error",
              signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) }) };
          });
          gate = slot.then(() => undefined, () => undefined);
          response = await (await slot).response;
        } catch { throw Error("devnet_rpc_unavailable"); }
        if (![429, 503].includes(response.status)) return response;
        if (attempt === 3) throw Error(response.status === 429 ? "devnet_rpc_rate_limited" : "devnet_rpc_unavailable");
        const seconds = Number(response.headers.get("retry-after"));
        const retryMs = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 8000) : 1000 * 2 ** attempt;
        nextStart = Math.max(nextStart, now() + retryMs);
        // Discard retry bodies without exposing upstream URLs or credentials.
        await response.body?.cancel();
      }
    };
    return new Promise((resolve, reject) => { queued.push({ task, resolve, reject }); drain(); });
  };
}

export function singleFlightCache(loader, ttlMs, now = Date.now) {
  let generation = 0, cached, expires = 0, pending;
  return {
    get() {
      if (cached !== undefined && now() < expires) return Promise.resolve(cached);
      if (pending?.generation === generation) return pending.promise;
      const record = { generation };
      record.promise = Promise.resolve().then(loader).then(value => {
        if (record.generation === generation) { cached = value; expires = now() + ttlMs; }
        return value;
      }).finally(() => { if (pending === record) pending = undefined; });
      pending = record;
      return record.promise;
    },
    invalidate() { generation++; cached = undefined; expires = 0; },
  };
}

export function safeRpcError(error) {
  const message = String(error?.message ?? "");
  if (error?.logs?.some(line => /Program was (deployed|extended) in this block already/.test(line))) return "program_slot_pending_retry_same_step";
  if (/devnet_rpc_rate_limited|429|too many requests/i.test(message)) return "devnet_rpc_rate_limited";
  if (/devnet_rpc_unavailable|503|fetch failed|ECONNRESET|ETIMEDOUT/i.test(message)) return "devnet_rpc_unavailable";
  return /^[a-z_]+$/.test(message) ? message : "devnet_action_failed_check_status";
}
