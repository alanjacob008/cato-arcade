import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { fetchCatoBalance, isWalletAddress, verifyWalletSignature } from "../updownGate.js";

function testWallet() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const address = new PublicKey(raw).toBase58();
  const signText = (text: string) => sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64");
  return { address, signText };
}

describe("wallet ownership proof", () => {
  it("accepts the wallet's own signature over the exact message", () => {
    const { address, signText } = testWallet();
    expect(verifyWalletSignature(address, "hello", signText("hello"))).toBe(true);
  });

  it("rejects another wallet's signature, a changed message and garbage", () => {
    const a = testWallet();
    const b = testWallet();
    expect(verifyWalletSignature(a.address, "hello", b.signText("hello"))).toBe(false);
    expect(verifyWalletSignature(a.address, "hello!", a.signText("hello"))).toBe(false);
    expect(verifyWalletSignature(a.address, "hello", "bm90LWEtc2ln")).toBe(false);
    expect(verifyWalletSignature("not-a-wallet", "hello", a.signText("hello"))).toBe(false);
  });

  it("validates addresses", () => {
    expect(isWalletAddress(testWallet().address)).toBe(true);
    expect(isWalletAddress("nope")).toBe(false);
    expect(isWalletAddress(42)).toBe(false);
  });
});

describe("CATO balance", () => {
  const rpc = (value: unknown[]) =>
    vi.fn(async () => ({ ok: true, json: async () => ({ result: { value } }) })) as unknown as typeof fetch;

  it("sums every token account for the mint", async () => {
    const account = (uiAmount: number | null) => ({ account: { data: { parsed: { info: { tokenAmount: { uiAmount } } } } } });
    const fetchImpl = rpc([account(40_000), account(12_345.5), account(null)]);
    expect(await fetchCatoBalance("W", "http://rpc", "MINT", fetchImpl)).toBe(52_345.5);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.method).toBe("getTokenAccountsByOwner");
    expect(body.params[0]).toBe("W");
    expect(body.params[1]).toEqual({ mint: "MINT" });
  });

  it("is zero without token accounts and throws on RPC errors", async () => {
    expect(await fetchCatoBalance("W", "http://rpc", "MINT", rpc([]))).toBe(0);
    const failing = vi.fn(async () => ({ ok: true, json: async () => ({ error: { message: "boom" } }) })) as unknown as typeof fetch;
    await expect(fetchCatoBalance("W", "http://rpc", "MINT", failing)).rejects.toThrow("boom");
  });
});
