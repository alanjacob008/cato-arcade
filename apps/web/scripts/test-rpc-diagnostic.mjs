import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const source = (await readFile(new URL("../server/rpc-diagnostic.ts", import.meta.url), "utf8")).replace('import "server-only";', "");
const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { diagnosticAuthorized, readRpcDiagnostic, readVrfPreflight } = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);
const secret = "test-only-diagnostic-token-32-characters";
assert(diagnosticAuthorized(`Bearer ${secret}`, secret));
for (const value of [null, secret, `Bearer ${secret}x`, "Bearer short", `Basic ${secret}`]) assert(!diagnosticAuthorized(value, secret));
assert(!diagnosticAuthorized(`Bearer ${secret}`, "short"));
assert(!diagnosticAuthorized(`Bearer ${secret}`, undefined));
let calls = 0;
const response = async (_url, options) => { calls++; assert.equal(options.headers.Origin, "https://example.vercel.app"); assert.equal(JSON.parse(options.body).method, "getVersion"); return Response.json({ result: { "solana-core": "test" } }); };
for (const rpcUrl of [undefined, "http://127.0.0.1", "https://attacker.example/", "https://mainnet.helius-rpc.com@attacker.example/", "https://mainnet.helius-rpc.com:444/", "https://mainnet.helius-rpc.com/path"]) {
  const result = await readRpcDiagnostic({ rpcUrl }, response); assert.equal(result.connected, false);
}
assert.equal(calls, 0, "Invalid endpoint configuration cannot perform requests");
const configured = { rpcUrl: "https://mainnet.helius-rpc.com/?api-key=never-log-this", origin: "https://example.vercel.app" };
assert.deepEqual(await readRpcDiagnostic(configured, response), { connected: true, vrf: "not_deployed" });
for (const origin of ["http://example.com", "https://example.com/claw", "https://user:pass@example.com", "https://example.com?token=secret"]) {
  assert.equal((await readRpcDiagnostic({ ...configured, origin }, response)).connected, false);
}
const rejected = await readRpcDiagnostic(configured, async () => new Response("private provider details", { status: 403 }));
assert.equal(rejected.upstreamStatus, 403); assert(!JSON.stringify(rejected).includes("private"));
const failed = await readRpcDiagnostic(configured, async () => { throw Error(configured.rpcUrl); });
assert(!JSON.stringify(failed).includes("never-log-this"));
assert.equal((await readRpcDiagnostic(configured, async () => Response.json({ error: { message: configured.rpcUrl } }))).reason, "invalid_response");
let preflightCalls = 0;
const preflight = async (_url, options) => {
  preflightCalls++;
  assert.equal(options.headers.Origin, configured.origin);
  const batch = JSON.parse(options.body);
  assert.deepEqual(batch.map(x => x.method), ["getGenesisHash", "getBalance", "getMultipleAccounts", ...Array(4).fill("getMinimumBalanceForRentExemption")]);
  assert.deepEqual(batch.slice(3).map(x => x.params[0]), [36, 1045, 1037, 117]);
  const results = ["mainnet-genesis", { value: 1e9 }, { value: [{ executable: true }, { owner: "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz" }, null] }, 100, 200, 300, 400];
  return Response.json(results.map((result, id) => ({ id, result })).reverse());
};
for (const size of [0, -1, 1.1, NaN, Infinity, 1048577]) assert.equal((await readVrfPreflight(configured, size, preflight)).connected, false);
assert.equal(preflightCalls, 0);
const ready = await readVrfPreflight(configured, 1000, preflight);
assert.equal(ready.connected, true); assert.equal(ready.queueOwnedByVrf, true);
assert.equal(ready.consumerExecutable, false); assert.equal(ready.fulfilledCallbackObserved, false);
assert.equal(ready.requiredRentFundingLamports, 400); assert.equal(ready.permanentRentLamports, 300);
assert.equal(ready.bufferRentReused, true); assert.equal(ready.mainnet, false); assert.equal(ready.feesIncluded, false);
assert.equal((await readVrfPreflight(configured, 1000, async () => Response.json([{ id: 0, result: "bad" }]))).connected, false);
const privateError = await readVrfPreflight(configured, 1000, async () => { throw Error(configured.rpcUrl); });
assert(!JSON.stringify(privateError).includes("never-log-this"));
console.log("PASS: protected RPC diagnostics/preflight, fixed Origin and destinations, credential redaction, rent sizing, and RPC/VRF status separation.");
