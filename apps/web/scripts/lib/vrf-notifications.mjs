import WebSocket from "ws";

export function createVrfNotifications({ endpoint, origin, program, onCallback, handler = "ConsumeProbe", Socket = WebSocket }) {
  const url = new URL(endpoint); url.protocol = "wss:";
  let socket, stopped = false, retry, reconnects = 0, subscription = null;
  const state = { connected: false, received: 0, lastNotificationAt: null };
  function connect() {
    if (stopped) return;
    socket = new Socket(url.href, { ...(origin ? { origin } : {}), maxPayload: 1024 * 1024, handshakeTimeout: 6000 });
    socket.on("open", () => socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1,
      method: "logsSubscribe", params: [{ mentions: [program] }, { commitment: "confirmed" }] })));
    socket.on("message", raw => {
      try {
        const message = JSON.parse(raw.toString());
        if (message.id === 1) {
          if (!Number.isSafeInteger(message.result)) { socket.terminate(); return; }
          subscription = message.result; state.connected = true; reconnects = 0; return;
        }
        const result = message.params?.result, value = result?.value;
        if (!state.connected || message.method !== "logsNotification" || message.params?.subscription !== subscription
          || !Number.isSafeInteger(result?.context?.slot) || result.context.slot < 0 || value?.err !== null
          || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(value?.signature ?? "")
          || !Array.isArray(value.logs) || !value.logs.includes(`Program log: Instruction: ${handler}`)) return;
        state.received++; state.lastNotificationAt = Date.now();
        Promise.resolve().then(() => onCallback({ signature: value.signature, slot: result.context.slot })).catch(() => {});
      } catch { /* Malformed hints cannot affect the verified result. HTTP remains active. */ }
    });
    socket.on("error", () => socket.terminate());
    socket.on("unexpected-response", (_request, response) => { response.destroy(); socket.terminate(); });
    socket.on("close", () => {
      state.connected = false; subscription = null;
      if (!stopped) { retry = setTimeout(connect, Math.min(15000, 1000 * 2 ** Math.min(reconnects++, 4))); retry.unref?.(); }
    });
  }
  connect();
  return { state: () => ({ ...state }), close() { stopped = true; clearTimeout(retry); socket?.terminate(); } };
}
