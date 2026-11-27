import { NextRequest, NextResponse } from "next/server";
import { MAX_RPC_BODY_BYTES, readBodyCapped, rpcOriginAllowed, rpcRelayBody } from "../../../lib/rpcProxy";

export const dynamic = "force-dynamic";

/**
 * Keyed upstream RPC, from server-only variables first. NEXT_PUBLIC_RPC_URL is last and,
 * being public, may only hold a keyless endpoint (the build rejects keyed public values).
 */
function upstreamRpcUrl(): string | null {
  const explicit = process.env.STAKE_RPC_URL?.trim();
  if (explicit) return explicit;

  const key = process.env.HELIUS_API_KEY?.trim();
  if (key) return `https://mainnet.helius-rpc.com/?api-key=${key}`;

  return process.env.NEXT_PUBLIC_RPC_URL?.trim() || null;
}

function rpcError(message: string, status: number) {
  return NextResponse.json(
    { jsonrpc: "2.0", error: { code: -32600, message }, id: null },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: NextRequest) {
  const url = upstreamRpcUrl();
  if (!url) return rpcError("RPC is not configured", 500);

  // Browsers on other sites may not use this proxy; scripts are bounded by rpcRequestError.
  if (!rpcOriginAllowed(req.headers.get("origin"), req.headers.get("host"))) {
    return rpcError("Origin not allowed", 403);
  }

  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_RPC_BODY_BYTES) return rpcError("Request too large", 413);
  // Bounded read: a body without (or with a false) Content-Length is not buffered past the cap.
  const raw = await readBodyCapped(req.body, MAX_RPC_BODY_BYTES);
  if (raw === null) return rpcError("Request too large", 413);
  const relay = rpcRelayBody(raw);
  if ("error" in relay) return rpcError(relay.error, relay.error === "Request too large" ? 413 : 400);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The checked value, re-serialised: never the caller's raw text.
      body: relay.body,
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return rpcError("Upstream RPC unavailable", 502);
  }
  const text = await res.text();
  return new NextResponse(text, {
    status: res.status,
    headers: {
      "content-type": res.headers.get("content-type") ?? "application/json",
      "cache-control": "no-store",
    },
  });
}
