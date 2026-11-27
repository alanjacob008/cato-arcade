import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { bundleCacheControl, middleware } from "../../middleware";
import { SESSION_COOKIE, sealToken, sessionSecret } from "../updownSession";

const request = async (path: string, signedIn: boolean) => {
  const cookie = signedIn ? `${SESSION_COOKIE}=${await sealToken({ wallet: "w", balance: 1, exp: Date.now() + 60_000 }, sessionSecret(), "session")}` : "";
  return middleware(new NextRequest(`https://cato.example${path}`, { headers: cookie ? { cookie } : {} }));
};

describe("Up Down gate and cache policy", () => {
  it("marks hashed assets immutable and everything else in the bundle revalidating", () => {
    expect(bundleCacheControl("/updown/assets/index-abc.js")).toBe("public, max-age=31536000, immutable");
    for (const path of ["/updown", "/updown/portfolio", "/updown/cato-icon.png"]) expect(bundleCacheControl(path)).toBe("no-cache");
    expect(bundleCacheControl("/game-api/rounds")).toBeNull();
  });

  it("never lets a sign-in redirect or 401 be cached", async () => {
    const redirect = await request("/updown/assets/index-abc.js", false);
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("location")).toBe("https://cato.example/play?next=%2Fupdown%2Fassets%2Findex-abc.js");
    expect(redirect.headers.get("cache-control")).toBe("private, no-store");
    const api = await request("/game-api/health", false);
    expect(api.status).toBe(401);
    expect(api.headers.get("cache-control")).toBe("private, no-store");
  });

  it("refuses the unauthenticated sign-in nonce presented as a session cookie", async () => {
    // GET /api/updown/nonce?wallet=... hands anyone a sealed nonce for any wallet.
    const nonce = await sealToken(
      { nonce: "n", wallet: "w", issuedAt: new Date().toISOString(), domain: "cato.example", exp: Date.now() + 60_000 },
      sessionSecret(),
      "nonce",
    );
    const headers = { cookie: `${SESSION_COOKIE}=${nonce}` };
    const api = await middleware(new NextRequest("https://cato.example/game-api/rounds", { headers }));
    expect(api.status).toBe(401);
    const page = await middleware(new NextRequest("https://cato.example/updown/", { headers }));
    expect(page.status).toBe(307);
  });

  it("passes signed-in requests through with the bundle cache policy", async () => {
    const asset = await request("/updown/assets/index-abc.js", true);
    expect(asset.headers.get("x-middleware-next")).toBe("1");
    expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect((await request("/game-api/health", true)).headers.get("cache-control")).toBeNull();
  });
});
