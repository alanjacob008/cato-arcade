import { describe, expect, it } from "vitest";
import idl from "../../../../idl/stake_rewards.json";
import {
  MAX_RPC_BATCH,
  MAX_RPC_BODY_BYTES,
  readBodyCapped,
  rpcOriginAllowed,
  rpcRelayBody,
  rpcRequestError,
} from "../rpcProxy.js";

const call = (method: string, params: unknown[] = [], id = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("public RPC proxy policy", () => {
  it("relays the calls the site makes", () => {
    expect(rpcRequestError(JSON.stringify(call("getAccountInfo", ["11111111111111111111111111111111"])))).toBeNull();
    expect(rpcRequestError(JSON.stringify([call("getLatestBlockhash"), call("sendTransaction", ["AQID"], 2)]))).toBeNull();
    expect(rpcRequestError(JSON.stringify(call("getProgramAccounts", [idl.address, { filters: [{ dataSize: 88 }] }])))).toBeNull();
  });

  it("refuses general-purpose use of the keyed upstream", () => {
    expect(rpcRequestError(JSON.stringify(call("getSignaturesForAddress", ["11111111111111111111111111111111"])))).toBe("Method not allowed");
    expect(rpcRequestError(JSON.stringify(call("getProgramAccounts", ["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"])))).toBe("Method not allowed");
    expect(rpcRequestError(JSON.stringify(Array.from({ length: MAX_RPC_BATCH + 1 }, (_, i) => call("getSlot", [], i))))).toBe("Batch too large");
    expect(rpcRequestError(JSON.stringify(call("getAccountInfo", ["x".repeat(MAX_RPC_BODY_BYTES)])))).toBe("Request too large");
    expect(rpcRequestError("[]")).toBe("Batch too large");
    expect(rpcRequestError("not json")).toBe("Invalid JSON");
    expect(rpcRequestError("[1]")).toBe("Invalid request");
  });

  it("refuses browser requests from other sites", () => {
    expect(rpcOriginAllowed(null, "www.ogcato.com")).toBe(true);
    expect(rpcOriginAllowed("https://www.ogcato.com", "www.ogcato.com")).toBe(true);
    expect(rpcOriginAllowed("https://attacker.example", "www.ogcato.com")).toBe(false);
    expect(rpcOriginAllowed("null", "www.ogcato.com")).toBe(false);
  });
});

describe("relayed body", () => {
  it("relays the checked value, not the caller's raw text", () => {
    // Two "method" members: JSON.parse keeps the last; an upstream parser might keep the first.
    const raw = '{"jsonrpc":"2.0","id":1,"method":"getSignaturesForAddress","params":[],"method":"getSlot"}';
    const relay = rpcRelayBody(raw);
    expect(relay).toEqual({ body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getSlot", params: [] }) });
    expect("body" in relay && relay.body.includes("getSignaturesForAddress")).toBe(false);
    expect(rpcRelayBody(JSON.stringify(call("getSignaturesForAddress")))).toEqual({ error: "Method not allowed" });
  });

  it("stops reading a body past the cap", async () => {
    const stream = (bytes: number) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent < bytes; sent += 1024) controller.enqueue(new Uint8Array(Math.min(1024, bytes - sent)).fill(32));
          controller.close();
        },
      });
    expect(await readBodyCapped(stream(MAX_RPC_BODY_BYTES), MAX_RPC_BODY_BYTES)).toHaveLength(MAX_RPC_BODY_BYTES);
    expect(await readBodyCapped(stream(MAX_RPC_BODY_BYTES + 1), MAX_RPC_BODY_BYTES)).toBeNull();
    expect(await readBodyCapped(null, MAX_RPC_BODY_BYTES)).toBe("");
  });
});
