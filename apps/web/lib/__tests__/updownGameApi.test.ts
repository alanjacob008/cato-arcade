import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { handleGameApi } from "../updownGameApi";
import { clearAccountCache } from "../updownAccounts";
import { SESSION_COOKIE, sealToken, sessionSecret } from "../updownSession";
import { UpdownConfigError, type UpdownRuntime } from "../updownRuntime";
import { RoundEngine } from "../../../updown/server/engine.mjs";
import { createJournalStore } from "../../../updown/server/store.mjs";
import { createGameApi } from "../../../updown/server/service.mjs";
import { OrderlyError } from "../../../updown/server/orderly.mjs";

const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const mine = "0x" + "a".repeat(64);
const theirs = "0x" + "b".repeat(64);
const SITE = "https://cato.example";

/** The real engine and routes over an in-memory journal; Orderly is mocked (no network, no orders). */
function fakeRuntime() {
  let now = 100_000;
  let position = 0;
  const orders = new Map<string, any>();
  const market = { symbol: "PERP_BTC_USDC", status: "ACTIVE", base_imr: 0.01, imr_factor: 0.000001, base_tick: 0.01, base_min: 0.01, base_max: 10000, min_notional: 1 };
  const request = vi.fn(async (path: string, credential?: any, method = "GET", body?: any): Promise<any> => {
    if (path.startsWith("/v1/get_account?")) {
      const query = new URL(path, "https://orderly.test").searchParams;
      if (query.get("address") === wallet && query.get("chain_type") === "SOL" && query.get("broker_id") === "cato") return { user_id: 1, account_id: mine };
      throw new OrderlyError("Account not found.", true, -1607);
    }
    if (path === "/v1/client/info") return { account_id: credential?.accountId };
    if (path === "/v1/positions" || path.includes("status=INCOMPLETE")) return { rows: [] };
    if (path === "/v1/public/info") return { rows: [market] };
    if (path === "/v1/public/futures") return { rows: [{ symbol: market.symbol, mark_price: 100 }] };
    if (path === "/v1/public/leverage") return { max_futures_leverage: 50 };
    if (path.startsWith("/v1/orderbook/")) return { bids: [{ price: 100, quantity: 5 }], asks: [{ price: 100.01, quantity: 5 }] };
    if (path === "/v1/client/leverages") return {};
    if (path.startsWith("/v1/position/")) return { position_qty: position, mark_price: 100, margin_mode: "ISOLATED" };
    if (path.startsWith("/v1/client/order/")) {
      const order = orders.get(decodeURIComponent(path.split("/").at(-1)!));
      if (!order) throw new OrderlyError("Order not found", true, -1006);
      return order;
    }
    if (path === "/v1/order" && method === "POST") {
      orders.set(body.client_order_id, { status: "FILLED", total_executed_quantity: body.order_quantity, average_executed_price: 100, total_fee: 0.01, updated_time: now, order_id: orders.size + 1 });
      position = body.reduce_only ? 0 : body.order_quantity;
      return { order_id: orders.size };
    }
    throw new Error("Unexpected request: " + path);
  });
  const store = createJournalStore({ load: () => [], save: () => {} });
  const engine = new RoundEngine({ request, store, network: "testnet", brokerId: "cato", now: () => now });
  const api = createGameApi({ engine, request, brokerId: "cato", tickOnRead: true, health: async () => ({ ready: true }) });
  const runtime = { config: { network: "testnet", brokerId: "cato", orderlyBase: "" }, request, store, engine, api } as unknown as UpdownRuntime;
  return { runtime, request, store, sends: () => request.mock.calls.filter((c) => c[0] === "/v1/order"), setTime: (t: number) => { now = t; } };
}

async function cookie(w = wallet) {
  return `${SESSION_COOKIE}=${await sealToken({ wallet: w, balance: 60_000, exp: Date.now() + 60_000 }, sessionSecret(), "session")}`;
}

async function call(rt: UpdownRuntime | (() => Promise<UpdownRuntime>), path: string, init: { body?: unknown; headers?: Record<string, string>; signedIn?: boolean; env?: NodeJS.ProcessEnv } = {}) {
  const headers: Record<string, string> = { ...(init.signedIn === false ? {} : { cookie: await cookie() }), ...init.headers };
  if (init.body !== undefined) {
    headers["content-type"] ??= "application/json";
    headers.origin ??= SITE;
  }
  const req = new NextRequest(SITE + path, { method: init.body === undefined ? "GET" : "POST", headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const res = await handleGameApi(req, { runtime: typeof rt === "function" ? rt : async () => rt, env: init.env ?? { NODE_ENV: "production", UPDOWN_BUNDLE: "1" } });
  return { status: res.status, body: await res.json(), headers: res.headers };
}

const start = (accountId: string, id = "round-0000001") => ({ id, accountId, secretKey: "test-only", symbol: "PERP_BTC_USDC", direction: "UP", duration: 300, margin: 10, leverage: 10, authorize: true });

beforeEach(() => clearAccountCache());

describe("game API on the website", () => {
  it("needs the session cookie and refuses cross-site requests", async () => {
    const f = fakeRuntime();
    expect((await call(f.runtime, "/game-api/health", { signedIn: false })).status).toBe(401);
    expect((await call(f.runtime, "/game-api/health", { headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await call(f.runtime, "/game-api/rounds", { body: start(mine), headers: { origin: "https://evil.example" } })).status).toBe(403);
    expect((await call(f.runtime, "/game-api/rounds", { body: start(mine), headers: { "content-type": "text/plain" } })).status).toBe(403);
    expect(f.sends()).toHaveLength(0);
    const health = await call(f.runtime, "/game-api/health");
    expect(health).toMatchObject({ status: 200, body: { ready: true } });
    expect(health.headers.get("cache-control")).toBe("no-store");
  });

  it("returns a session without a token (the cookie authenticates)", async () => {
    const f = fakeRuntime();
    const session = await call(f.runtime, "/game-api/session", { env: { NODE_ENV: "production", UPDOWN_BUNDLE: "1", VITE_DEPLOYMENT_ENV: "mainnet" } });
    expect(session).toMatchObject({ status: 200, body: { network: "mainnet", wallet } });
    expect(session.body).not.toHaveProperty("token");
  });

  it("serves only the BTC market and no price routes (marks/candles are gone)", async () => {
    const f = fakeRuntime();
    const markets = await call(f.runtime, "/game-api/markets");
    expect(markets.status).toBe(200);
    expect(markets.body.rows).toHaveLength(1);
    expect(markets.body.rows[0]).toMatchObject({ symbol: "PERP_BTC_USDC", mark_price: 100, maxLeverage: 50 });
    expect(await call(f.runtime, "/game-api/marks?symbol=PERP_BTC_USDC")).toMatchObject({ status: 404 });
    expect(await call(f.runtime, "/game-api/candles?symbol=PERP_BTC_USDC")).toMatchObject({ status: 404 });
    expect(f.request.mock.calls.filter((c) => c[0] === "/v1/public/query")).toHaveLength(0);
  });

  it("starts rounds on BTC only, at the market's maximum leverage for the amount", async () => {
    const f = fakeRuntime();
    expect(await call(f.runtime, "/game-api/rounds", { body: { ...start(mine), symbol: "PERP_SOL_USDC" } })).toMatchObject({ status: 400, body: { error: "Only BTC is playable." } });
    expect(f.sends()).toHaveLength(0);
    const started = await call(f.runtime, "/game-api/rounds", { body: { ...start(mine), leverage: 2 } });
    expect(started).toMatchObject({ status: 200, body: { status: "opening", symbol: "PERP_BTC_USDC", leverage: 50 } });
  });

  it("only lists and starts rounds for the signed-in wallet's own Orderly account", async () => {
    const f = fakeRuntime();
    expect(await call(f.runtime, `/game-api/rounds?accountId=${theirs}`)).toMatchObject({ status: 403 });
    expect(await call(f.runtime, "/game-api/rounds?accountId=nonsense")).toMatchObject({ status: 400 });
    expect(await call(f.runtime, "/game-api/rounds", { body: start(theirs) })).toMatchObject({ status: 403 });
    expect(f.sends()).toHaveLength(0);
    expect(await call(f.runtime, `/game-api/rounds?accountId=${mine}`)).toMatchObject({ status: 200, body: { rows: [] } });
    const started = await call(f.runtime, "/game-api/rounds", { body: start(mine) });
    expect(started).toMatchObject({ status: 200, body: { status: "opening", accountId: mine } });
    expect(JSON.stringify(started.body)).not.toContain("test-only");
    // The player's poll advances the round (no background worker).
    f.setTime(101_000);
    const listed = await call(f.runtime, `/game-api/rounds?accountId=${mine}`);
    expect(listed.body.rows[0]).toMatchObject({ status: "open", deadline: 400_000 });
    // Lookups are cached per instance.
    expect(f.request.mock.calls.filter((c) => String(c[0]).startsWith("/v1/get_account?"))).toHaveLength(1);
  });

  it("rejects close, extend and reconcile on rounds owned by another account", async () => {
    const f = fakeRuntime();
    await f.store.insert({ id: "their-round-01", accountId: theirs, network: "testnet", symbol: "PERP_BTC_USDC", direction: "UP", duration: 300, margin: 10, leverage: 10, quantity: 1, status: "open", createdAt: 1, openedAt: 1, deadline: 9e15, positionQuantity: 1, closeAttempts: [], credential: { accountId: theirs, secretKey: "x" } });
    for (const [verb, body] of [["close", {}], ["extend", { id: "extension-01", seconds: 300, accountId: mine, secretKey: "11111111111111111111111111111111" }], ["reconcile", { accountId: mine, secretKey: "k" }]] as const) {
      expect(await call(f.runtime, `/game-api/rounds/their-round-01/${verb}`, { body })).toMatchObject({ status: 403 });
    }
    expect(f.sends()).toHaveLength(0);
    expect((await f.store.get("their-round-01"))).not.toHaveProperty("closeNow");
  });

  it("closes the player's own round on request", async () => {
    const f = fakeRuntime();
    await call(f.runtime, "/game-api/rounds", { body: start(mine) });
    f.setTime(101_000);
    await call(f.runtime, `/game-api/rounds?accountId=${mine}`);
    const closed = await call(f.runtime, "/game-api/rounds/round-0000001/close", { body: {} });
    expect(closed).toMatchObject({ status: 200, body: { status: "closing" } });
    expect(f.sends().at(-1)![3]).toMatchObject({ reduce_only: true, margin_mode: "ISOLATED" });
  });

  it("refuses a wallet with no Orderly account, and reports Orderly outages as 503", async () => {
    const f = fakeRuntime();
    const other = await cookie("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
    expect(await call(f.runtime, `/game-api/rounds?accountId=${mine}`, { headers: { cookie: other } })).toMatchObject({ status: 403 });
    clearAccountCache();
    f.request.mockImplementationOnce(async () => { throw new OrderlyError("Service unavailable", false); });
    expect(await call(f.runtime, `/game-api/rounds?accountId=${mine}`)).toMatchObject({ status: 503 });
  });

  it("is off (503) in a production build without the game bundle, and names missing settings", async () => {
    const f = fakeRuntime();
    expect(await call(f.runtime, "/game-api/health", { env: { NODE_ENV: "production" } })).toMatchObject({ status: 503, body: { error: "Up Down is coming online soon." } });
    const failing = async () => { throw new UpdownConfigError("DATABASE_URL is not set."); };
    expect(await call(failing, "/game-api/health")).toMatchObject({ status: 503, body: { error: "DATABASE_URL is not set." } });
  });

  it("answers malformed JSON generically, without echoing the body", async () => {
    const f = fakeRuntime();
    const req = new NextRequest(SITE + "/game-api/rounds", {
      method: "POST",
      headers: { cookie: await cookie(), origin: SITE, "content-type": "application/json" },
      body: '{"secretKey": "do-not-echo-me", oops',
    });
    const res = await handleGameApi(req, { runtime: async () => f.runtime, env: { NODE_ENV: "production", UPDOWN_BUNDLE: "1" } });
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body).toEqual({ error: "Invalid JSON." });
    expect(JSON.stringify(body)).not.toContain("do-not-echo-me");
    expect(f.sends()).toHaveLength(0);
  });

  it("refuses mainnet on a preview deployment and an unknown network value, before touching the runtime", async () => {
    const f = fakeRuntime();
    const runtime = vi.fn(async () => f.runtime);
    const base = { NODE_ENV: "production", UPDOWN_BUNDLE: "1" } as const;
    const preview = await call(runtime, "/game-api/health", { env: { ...base, VITE_DEPLOYMENT_ENV: "mainnet", VERCEL_ENV: "preview" } });
    expect(preview).toMatchObject({ status: 503, body: { error: expect.stringContaining("does not play on mainnet from a preview deployment") } });
    const session = await call(runtime, "/game-api/session", { env: { ...base, VITE_DEPLOYMENT_ENV: "mainnet", VERCEL_ENV: "preview" } });
    expect(session.status).toBe(503);
    const unknown = await call(runtime, "/game-api/health", { env: { ...base, VITE_DEPLOYMENT_ENV: "prod" } });
    expect(unknown).toMatchObject({ status: 503, body: { error: expect.stringContaining('must be "mainnet" or "testnet"') } });
    expect(runtime).not.toHaveBeenCalled();
    const allowed = await call(runtime, "/game-api/health", { env: { ...base, VITE_DEPLOYMENT_ENV: "mainnet", VERCEL_ENV: "preview", UPDOWN_ALLOW_PREVIEW_MAINNET: "1" } });
    expect(allowed.status).toBe(200);
    const testnetPreview = await call(runtime, "/game-api/health", { env: { ...base, VITE_DEPLOYMENT_ENV: "testnet", VERCEL_ENV: "preview" } });
    expect(testnetPreview.status).toBe(200);
  });
});
