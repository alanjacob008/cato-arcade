import { diagnosticAuthorized, readVrfPreflight } from "../../../../server/rpc-diagnostic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (!diagnosticAuthorized(request.headers.get("authorization"), process.env.RPC_DIAGNOSTIC_TOKEN)) {
    return Response.json({ error: "not_found" }, { status: 404, headers });
  }
  const binaryBytes = Number(new URL(request.url).searchParams.get("bytes"));
  const result = await readVrfPreflight({ rpcUrl: process.env.HELIUS_RPC_URL, origin: process.env.APP_ORIGIN }, binaryBytes);
  return Response.json(result, { status: result.connected ? 200 : 503, headers });
}
