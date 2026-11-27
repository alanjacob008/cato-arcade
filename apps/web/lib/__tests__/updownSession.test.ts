import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildSignInMessage, openNonce, openSession, openToken, sealToken } from "../updownSession.js";

describe("updown session tokens", () => {
  const secret = "test-secret";

  it("round-trips a payload", async () => {
    const token = await sealToken({ wallet: "abc", exp: Date.now() + 1000 }, secret, "session");
    expect(await openToken<{ wallet: string; exp: number }>(token, secret, "session")).toMatchObject({ wallet: "abc" });
  });

  it("rejects a tampered body, a wrong secret and a missing token", async () => {
    const token = await sealToken({ wallet: "abc", exp: Date.now() + 1000 }, secret, "session");
    const [body, sig] = token.split(".");
    const forged = `${body.slice(0, -2)}AA.${sig}`;
    expect(await openToken(forged, secret, "session")).toBeNull();
    expect(await openToken(token, "other", "session")).toBeNull();
    expect(await openToken(undefined, secret, "session")).toBeNull();
    expect(await openToken("not-a-token", secret, "session")).toBeNull();
  });

  it("expires", async () => {
    const token = await sealToken({ exp: 1000 }, secret, "nonce");
    expect(await openToken(token, secret, "nonce", 999)).not.toBeNull();
    expect(await openToken(token, secret, "nonce", 1000)).toBeNull();
  });

  it("never opens a token sealed for another purpose", async () => {
    // The sign-in nonce is issued to anyone for any wallet, so it must not pass as a session.
    const nonce = await sealToken({ nonce: "n", wallet: "W", issuedAt: "t", domain: "d", exp: Date.now() + 1000 }, secret, "nonce");
    expect(await openToken(nonce, secret, "session")).toBeNull();
    const session = await sealToken({ wallet: "W", balance: 1, exp: Date.now() + 1000 }, secret, "session");
    expect(await openToken(session, secret, "nonce")).toBeNull();
  });

  it("binds the message to site, wallet, nonce and time", () => {
    const message = buildSignInMessage("www.ogcato.com", "W", "N", "2026-10-10T00:00:00.000Z");
    // Sign In With Solana form: the first line names the site, the second the wallet.
    expect(message.split("\n").slice(0, 2)).toEqual(["www.ogcato.com wants you to sign in with your Solana account:", "W"]);
    expect(message).toContain("URI: https://www.ogcato.com");
    expect(message).toContain("Chain ID: mainnet");
    expect(message).toContain("Nonce: N");
    expect(message).toContain("Issued At: 2026-10-10T00:00:00.000Z");
    expect(message).toMatch(/does not approve any transaction/);
    // A message issued for another site is different text, so its signature does not verify here.
    expect(buildSignInMessage("attacker.example", "W", "N", "2026-10-10T00:00:00.000Z")).not.toBe(message);
  });
});

describe("openSession / openNonce", () => {
  const saved = process.env.UPDOWN_SESSION_SECRET;
  beforeEach(() => {
    process.env.UPDOWN_SESSION_SECRET = "cookie-secret";
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.UPDOWN_SESSION_SECRET;
    else process.env.UPDOWN_SESSION_SECRET = saved;
  });

  it("accepts a session cookie and refuses the nonce cookie as a session", async () => {
    const exp = Date.now() + 60_000;
    const session = await sealToken({ wallet: "W", balance: 60_000, exp }, "cookie-secret", "session");
    expect(await openSession(session)).toMatchObject({ wallet: "W", balance: 60_000 });
    const nonce = await sealToken({ nonce: "n", wallet: "W", issuedAt: "t", domain: "d", exp }, "cookie-secret", "nonce");
    expect(await openSession(nonce)).toBeNull();
    expect(await openNonce(nonce)).toMatchObject({ wallet: "W", domain: "d" });
    expect(await openNonce(session)).toBeNull();
  });

  it("refuses a session-purpose token without a wallet and balance", async () => {
    const exp = Date.now() + 60_000;
    expect(await openSession(await sealToken({ exp }, "cookie-secret", "session"))).toBeNull();
    expect(await openSession(await sealToken({ wallet: "W", exp }, "cookie-secret", "session"))).toBeNull();
  });
});
