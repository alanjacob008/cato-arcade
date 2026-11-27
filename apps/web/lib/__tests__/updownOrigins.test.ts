import { describe, expect, it } from "vitest";
import { resolveUpdownOrigin, updownBundleRewrites, updownRewrites } from "../updownOrigins.mjs";

const dev = { NODE_ENV: "development" };
const prod = { NODE_ENV: "production" };

describe("Up Down serving", () => {
  it("dev proxies the bundle to the Vite dev server and keeps /game-api on the site", () => {
    expect(updownRewrites(dev)).toEqual([
      { source: "/updown", destination: "http://127.0.0.1:5185/updown/" },
      { source: "/updown/:path*", destination: "http://127.0.0.1:5185/updown/:path*" },
    ]);
  });

  it("dev can point /game-api at the standalone local worker", () => {
    expect(updownRewrites({ ...dev, UPDOWN_WORKER_ORIGIN: "http://127.0.0.1:5186/" })).toContainEqual({
      source: "/game-api/:path*",
      destination: "http://127.0.0.1:5186/game-api/:path*",
    });
  });

  it("production never proxies anywhere", () => {
    const configured = { ...prod, UPDOWN_ORIGIN: "https://game.example.com", UPDOWN_WORKER_ORIGIN: "https://rounds.example.com" };
    for (const env of [prod, { VERCEL: "1" }, { VERCEL_ENV: "preview" }, configured]) {
      expect(updownRewrites(env)).toEqual([]);
    }
    expect(resolveUpdownOrigin("UPDOWN_ORIGIN", configured)).toBeNull();
  });

  it("serves the built bundle with an SPA fallback that leaves assets alone", () => {
    expect(updownBundleRewrites(false)).toEqual([]);
    const [root, missing, fallback] = updownBundleRewrites(true);
    expect(root).toEqual({ source: "/updown", destination: "/updown/index.html" });
    expect(missing).toEqual({ source: "/updown/assets/:path*", destination: "/api/updown/missing" });
    expect(fallback.destination).toBe("/updown/index.html");
    // The source's custom parameter pattern, as Next's path matching applies it.
    const pattern = new RegExp("^/updown/" + fallback.source.slice("/updown/:path".length) + "$");
    for (const path of ["/updown/portfolio", "/updown/portfolio/history", "/updown/"]) expect(pattern.test(path)).toBe(true);
    expect(pattern.test("/updown/assets/index-abc123.js")).toBe(false);
  });
});
