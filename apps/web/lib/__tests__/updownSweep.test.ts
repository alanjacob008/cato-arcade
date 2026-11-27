import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { cronAuthorized, runSweep, SWEEP_MAX_DURATION_S, SWEEP_SAFETY_MARGIN_MS } from "../updownSweep";
import { GET as sweepRoute, maxDuration } from "../../app/api/updown/sweep/route";
import { RoundEngine } from "../../../updown/server/engine.mjs";
import { createJournalStore } from "../../../updown/server/store.mjs";
import { OrderlyError } from "../../../updown/server/orderly.mjs";

function lockStore() {
  let held = false;
  return {
    async withLock<T>(_names: string[], fn: () => Promise<T>) {
      if (held) return { acquired: false };
      held = true;
      try {
        return { acquired: true, value: await fn() };
      } finally {
        held = false;
      }
    },
  };
}

describe("cron sweep loop", () => {
  it("exits immediately when nothing is due", async () => {
    const engine = { tick: vi.fn(async () => 0) };
    const sleep = vi.fn(async () => {});
    expect(await runSweep({ engine, store: lockStore(), sleep })).toMatchObject({ iterations: 1, maxDue: 0 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it("repeats about every second until the rounds are done or the budget is spent", async () => {
    let clock = 0;
    const now = () => clock;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const done = { tick: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1).mockResolvedValue(0) };
    expect(await runSweep({ engine: done, store: lockStore(), now, sleep })).toMatchObject({ iterations: 3, maxDue: 1 });
    clock = 0;
    const busy = { tick: vi.fn(async () => 2) };
    const result = await runSweep({ engine: busy, store: lockStore(), now, sleep, budgetMs: 55_000 });
    expect(result.iterations).toBe(55);
    expect(result.elapsedMs).toBeLessThan(55_000);
  });

  it("stops starting rounds once the safety margin before maxDuration is reached", async () => {
    let clock = 0;
    const budgets: boolean[][] = [];
    const engine = {
      tick: vi.fn(async ({ continueWhile }: { continueWhile?: () => boolean } = {}) => {
        // A slow pass: each round in it takes 30s.
        const seen: boolean[] = [];
        for (let i = 0; i < 4; i++) {
          seen.push(continueWhile!());
          if (seen.at(-1)) clock += 30_000;
        }
        budgets.push(seen);
        return 4;
      }),
    };
    const result = await runSweep({ engine, store: lockStore(), now: () => clock, sleep: async (ms) => { clock += ms; } });
    // 0s, 30s, 60s started; 90s is past 120s - 45s, so nothing more starts and no second pass runs.
    expect(budgets).toEqual([[true, true, true, false]]);
    expect(result.iterations).toBe(1);
    expect(SWEEP_MAX_DURATION_S * 1000 - SWEEP_SAFETY_MARGIN_MS).toBe(75_000);
    expect(maxDuration).toBe(SWEEP_MAX_DURATION_S);
  });

  it("skips while another sweep holds the lease", async () => {
    const store = lockStore();
    let release!: () => void;
    const engine = {
      tick: vi.fn(
        () =>
          new Promise<number>((resolve) => {
            release = () => resolve(0);
          }),
      ),
    };
    const first = runSweep({ engine, store });
    await vi.waitFor(() => expect(engine.tick).toHaveBeenCalled());
    expect(await runSweep({ engine, store })).toMatchObject({ skipped: "Another sweep is running." });
    release();
    expect(await first).toMatchObject({ iterations: 1 });
  });

  it("closes an abandoned round right after its deadline with no player polling", async () => {
    let now = 100_000;
    let position = 0;
    const orders = new Map<string, any>();
    const request = vi.fn(async (path: string, credential?: any, method = "GET", body?: any): Promise<any> => {
      if (path === "/v1/client/info") return { account_id: credential.accountId };
      if (path === "/v1/positions" || path.includes("status=INCOMPLETE")) return { rows: [] };
      if (path === "/v1/public/info") {
        return { rows: [{ symbol: "PERP_BTC_USDC", status: "ACTIVE", base_imr: 0.01, imr_factor: 0.000001, base_tick: 0.0001, base_min: 0.0001, base_max: 100, min_notional: 1 }] };
      }
      if (path === "/v1/public/futures") return { rows: [{ symbol: "PERP_BTC_USDC", mark_price: 50000 }] };
      if (path === "/v1/public/leverage") return { max_futures_leverage: 50 };
      if (path.startsWith("/v1/orderbook/")) return { bids: [{ price: 49999, quantity: 5 }], asks: [{ price: 50000, quantity: 5 }] };
      if (path === "/v1/client/leverages") return {};
      if (path.startsWith("/v1/position/")) return { position_qty: position, mark_price: 50000, margin_mode: "ISOLATED" };
      if (path.startsWith("/v1/client/order/")) {
        const order = orders.get(decodeURIComponent(path.split("/").at(-1)!));
        if (!order) throw new OrderlyError("Order not found", true, -1006);
        return order;
      }
      if (path === "/v1/order" && method === "POST") {
        orders.set(body.client_order_id, { status: "FILLED", total_executed_quantity: body.order_quantity, average_executed_price: 50000, total_fee: 0.01, updated_time: now, order_id: 1 });
        position = body.reduce_only ? 0 : -body.order_quantity;
        return { order_id: 1 };
      }
      throw new Error("Unexpected request: " + path);
    });
    const store = createJournalStore({ load: () => [], save: () => {} });
    const engine = new RoundEngine({ request, store, network: "testnet", brokerId: "cato", now: () => now, minTickMs: 900 });
    await engine.start({ id: "abandoned-round", accountId: "0x" + "e".repeat(64), secretKey: "k", symbol: "PERP_BTC_USDC", direction: "DOWN", duration: 300, margin: 10, leverage: 10, authorize: true });
    // The tab is closed. A sweep runs every minute and loops with ~1s sleeps.
    const sleep = async (ms: number) => {
      now += ms;
    };
    await runSweep({ engine, store, now: () => now, sleep });
    expect((await store.get("abandoned-round"))?.status).toBe("open");
    now = 400_000;
    const result = await runSweep({ engine, store, now: () => now, sleep });
    const round = await store.get("abandoned-round");
    expect(round).toMatchObject({ status: "closed" });
    expect(round!.closedAt! - 400_000).toBeLessThanOrEqual(5_000);
    expect(result.iterations).toBeLessThan(10);
    expect(request.mock.calls.filter((c) => c[0] === "/v1/order").map((c) => c[3].reduce_only ?? false)).toEqual([false, true]);
  });
});

describe("cron authentication", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("accepts only the exact bearer secret", () => {
    expect(cronAuthorized("Bearer s3cret", "s3cret")).toBe(true);
    expect(cronAuthorized("Bearer wrong", "s3cret")).toBe(false);
    expect(cronAuthorized("s3cret", "s3cret")).toBe(false);
    expect(cronAuthorized(null, "s3cret")).toBe(false);
    expect(cronAuthorized("Bearer ", "")).toBe(false);
    expect(cronAuthorized("Bearer undefined", undefined)).toBe(false);
  });

  it("the sweep route rejects a missing or wrong secret before touching the database", async () => {
    vi.stubEnv("DATABASE_URL", "postgres://nobody@127.0.0.1:1/none");
    const get = (auth?: string) =>
      sweepRoute(new NextRequest("https://cato.example/api/updown/sweep", { headers: auth ? { authorization: auth } : {} }));
    vi.stubEnv("CRON_SECRET", "");
    expect((await get("Bearer anything")).status).toBe(503);
    vi.stubEnv("CRON_SECRET", "s3cret");
    expect((await get()).status).toBe(401);
    expect((await get("Bearer wrong")).status).toBe(401);
  });
});
