import { diagnosticAuthorized, readRpcDiagnostic } from "../../../../server/rpc-diagnostic";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
  if (!diagnosticAuthorized(request.headers.get("authorization"), process.env.RPC_DIAGNOSTIC_TOKEN)) {
    return Response.json({ error: "not_found" }, { status: 404, headers });
  }
  const status = await readRpcDiagnostic({ rpcUrl: process.env.HELIUS_RPC_URL, origin: process.env.APP_ORIGIN });
  return Response.json(status, { status: status.connected ? 200 : 503, headers });
}
