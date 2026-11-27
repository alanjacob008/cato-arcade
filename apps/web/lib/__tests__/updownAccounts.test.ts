import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountAuthorizer, clearAccountCache, orderlyAccountFor } from "../updownAccounts";
import { OrderlyError } from "../../../updown/server/orderly.mjs";

const wallet = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
const ACCOUNT = "0x" + "AbC1".repeat(16);

beforeEach(() => clearAccountCache());

describe("signed-in wallet to Orderly account", () => {
  it("asks Orderly for the wallet's Solana account on this broker and caches it", async () => {
    let now = 0;
    const request = vi.fn(async () => ({ user_id: 7, account_id: ACCOUNT }));
    const deps = { request, brokerId: "cato broker", now: () => now };
    expect(await orderlyAccountFor(wallet, deps)).toBe(ACCOUNT.toLowerCase());
    expect(request).toHaveBeenCalledWith(`/v1/get_account?address=${wallet}&broker_id=cato%20broker&chain_type=SOL`);
    now = 9 * 60_000;
    await orderlyAccountFor(wallet, deps);
    expect(request).toHaveBeenCalledTimes(1);
    now = 11 * 60_000;
    await orderlyAccountFor(wallet, deps);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("treats only Orderly's 'Account not found' as no account, and only briefly", async () => {
    let now = 0;
    const request = vi.fn().mockRejectedValueOnce(new OrderlyError("Account not found.", true, -1607)).mockResolvedValue({ account_id: ACCOUNT });
    const deps = { request, brokerId: "cato", now: () => now };
    expect(await orderlyAccountFor(wallet, deps)).toBeNull();
    expect(await orderlyAccountFor(wallet, deps)).toBeNull();
    now = 16_000;
    expect(await orderlyAccountFor(wallet, deps)).toBe(ACCOUNT.toLowerCase());
    clearAccountCache();
    const broken = vi.fn().mockRejectedValue(new OrderlyError("brokerId is not exist", true, -1614));
    await expect(orderlyAccountFor(wallet, { request: broken, brokerId: "x" })).rejects.toMatchObject({ status: 503 });
    const down = vi.fn().mockRejectedValue(new Error("fetch failed"));
    await expect(orderlyAccountFor(wallet, { request: down, brokerId: "x" })).rejects.toMatchObject({ status: 503 });
  });

  it("authorizes only that account (case-insensitively) and rejects malformed ids", async () => {
    const authorize = accountAuthorizer(wallet, { request: async () => ({ account_id: ACCOUNT }), brokerId: "cato" });
    await expect(authorize(ACCOUNT.toLowerCase())).resolves.toBeUndefined();
    await expect(authorize(ACCOUNT)).resolves.toBeUndefined();
    await expect(authorize("0x" + "f".repeat(64))).rejects.toMatchObject({ status: 403 });
    for (const bad of [undefined, null, "", "0x123", 42]) await expect(authorize(bad)).rejects.toMatchObject({ status: 400 });
  });
});
