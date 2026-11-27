import "server-only";
import { timingSafeEqual } from "node:crypto";

export function diagnosticAuthorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 32 || !header?.startsWith("Bearer ")) return false;
  const expected = Buffer.from(secret), supplied = Buffer.from(header.slice(7));
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

type Configuration = { rpcUrl?: string; origin?: string };
function rpcConfiguration(config: Configuration) {
  if (!config.rpcUrl) throw new Error("unconfigured");
  const endpoint = new URL(config.rpcUrl);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.port
    || endpoint.pathname !== "/" || !["mainnet.helius-rpc.com", "beta.helius-rpc.com"].includes(endpoint.hostname)) {
    throw new Error("invalid_configuration");
  }
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.origin) {
    const origin = new URL(config.origin);
    if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error("invalid_configuration");
    }
    headers.Origin = origin.origin;
  }
  return { endpoint, headers };
}
export async function readRpcDiagnostic(config: Configuration, fetcher: typeof fetch = fetch) {
  if (!config.rpcUrl) return { connected: false, reason: "unconfigured", vrf: "not_deployed" };
  try {
    let parsed;
    try { parsed = rpcConfiguration(config); }
    catch { return { connected: false, reason: "invalid_configuration", vrf: "not_deployed" }; }
    // Fixed deployment configuration, never a caller-supplied Host/Origin value.
    const { endpoint, headers } = parsed;
    const response = await fetcher(endpoint, {
      method: "POST", headers, cache: "no-store", signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion", params: [] }),
    });
    if (!response.ok) return { connected: false, upstreamStatus: response.status, reason: "upstream_rejected", vrf: "not_deployed" };
    const data = await response.json();
    if (data.error || typeof data.result?.["solana-core"] !== "string") return { connected: false, reason: "invalid_response", vrf: "not_deployed" };
    return { connected: true, vrf: "not_deployed" };
  } catch {
    // Never return or log an upstream response, URL, exception, or API key.
    return { connected: false, reason: "connection_failed", vrf: "not_deployed" };
  }
}

const VRF_PROGRAM = "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz";
const VRF_QUEUE = "Cuj97ggrhhidhbu39TijNVqE74xvKJ69gDervRUXAxGh";
const TREASURY = "C4xZVdouF6Qpd5PndLQe1HPYoBQBSqh7ag9nyXGahigg";
const PROBE_PROGRAM = "FYrH8Zsey8799rw5tygGDfm5JX55Mersz3ArAufJCctE";

// Private, read-only preflight. No caller-chosen RPC methods, addresses or destinations.
export async function readVrfPreflight(config: Configuration, binaryBytes: number, fetcher: typeof fetch = fetch) {
  if (!Number.isSafeInteger(binaryBytes) || binaryBytes < 1 || binaryBytes > 1_048_576) {
    return { connected: false, reason: "invalid_binary_size" };
  }
  try {
    const { endpoint, headers } = rpcConfiguration(config);
    const requests = [
      { method: "getGenesisHash", params: [] },
      { method: "getBalance", params: [TREASURY, { commitment: "confirmed" }] },
      { method: "getMultipleAccounts", params: [[VRF_PROGRAM, VRF_QUEUE, PROBE_PROGRAM], { encoding: "base64", commitment: "confirmed", dataSlice: { offset: 0, length: 0 } }] },
      ...[36, 45 + binaryBytes, 37 + binaryBytes, 117].map(size => ({ method: "getMinimumBalanceForRentExemption", params: [size, { commitment: "confirmed" }] })),
    ].map((value, id) => ({ jsonrpc: "2.0", id, ...value }));
    const response = await fetcher(endpoint, {
      method: "POST", headers, cache: "no-store", signal: AbortSignal.timeout(8000), body: JSON.stringify(requests),
    });
    if (!response.ok) return { connected: false, reason: "upstream_rejected", upstreamStatus: response.status };
    const data: unknown = await response.json();
    if (!Array.isArray(data) || data.length !== requests.length) throw new Error("invalid_response");
    const results = new Map<number, unknown>();
    for (const item of data) {
      if (!item || !Number.isInteger(item.id) || results.has(item.id) || item.error || !("result" in item)) throw new Error("invalid_response");
      results.set(item.id, item.result);
    }
    const genesis = results.get(0);
    const balance = results.get(1) as { value?: unknown } | undefined;
    const accounts = results.get(2) as { value?: { owner?: string; executable?: boolean }[] } | undefined;
    const rent = [3, 4, 5, 6].map(id => results.get(id));
    if (typeof genesis !== "string" || !Number.isSafeInteger(balance?.value) || (balance!.value as number) < 0
      || !Array.isArray(accounts?.value) || accounts.value.length !== 3
      || !rent.every(value => Number.isSafeInteger(value) && (value as number) > 0)) throw new Error("invalid_response");
    const [program, programData, buffer, attempt] = rent as number[];
    const [oracle, queue, consumer] = accounts.value;
    return {
      connected: true, genesisHash: genesis,
      mainnet: genesis === "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
      treasury: TREASURY, treasuryLamports: balance!.value as number,
      vrfProgramExecutable: oracle?.executable === true, queueOwnedByVrf: queue?.owner === VRF_PROGRAM,
      consumerProgram: PROBE_PROGRAM, consumerExecutable: consumer?.executable === true,
      binaryBytes, rentLamports: { program, programData, buffer, attempt },
      // Loader v3 drains buffer rent back to the payer before funding ProgramData.
      requiredRentFundingLamports: program + Math.max(programData, buffer),
      permanentRentLamports: program + programData, bufferRentReused: true,
      feesIncluded: false, fulfilledCallbackObserved: false,
    };
  } catch {
    return { connected: false, reason: "preflight_failed" };
  }
}
