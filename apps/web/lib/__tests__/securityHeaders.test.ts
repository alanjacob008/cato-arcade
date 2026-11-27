import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import nextConfig from "../../next.config.mjs";
import {
  JUPITER_PLUGIN_ORIGIN,
  securityHeaderRules,
  serializeCsp,
  siteReportOnlyDirectives,
  updownReportOnlyDirectives,
} from "../securityHeaders.mjs";

type Header = { key: string; value: string };
type Rule = { source: string; headers: Header[] };

const prod = { NODE_ENV: "production", NEXT_PUBLIC_SITE_URL: "https://www.ogcato.com" };
const web = resolve(__dirname, "../..");

const headerMap = (rule: Rule) => Object.fromEntries(rule.headers.map((h) => [h.key, h.value]));

/** Parses "a x y; b z" into { a: ["x", "y"], b: ["z"] }. */
function parseCsp(value: string): Record<string, string[]> {
  return Object.fromEntries(
    value.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...sources]) => [name, sources]),
  );
}

describe("site-wide security headers", () => {
  const [site, updown] = securityHeaderRules(prod) as Rule[];
  const headers = headerMap(site);

  it("apply to every route, including / , /api and /updown", () => {
    expect(site.source).toBe("/:path*");
    expect(headers["X-Frame-Options"]).toBe("DENY");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
    expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["Permissions-Policy"]).toMatch(/camera=\(\)/);
    expect(headers["Permissions-Policy"]).toMatch(/microphone=\(\)/);
    expect(headers["Permissions-Policy"]).not.toMatch(/fullscreen|autoplay|clipboard|hid|usb/);
    expect(headers["Strict-Transport-Security"]).toBeUndefined(); // set by Vercel on the domain
  });

  it("enforce only the directives nothing on the site relies on", () => {
    expect(parseCsp(headers["Content-Security-Policy"])).toEqual({
      "frame-ancestors": ["'none'"],
      "object-src": ["'none'"],
      "base-uri": ["'self'"],
      "form-action": ["'self'"],
    });
  });

  it("report the full allowlist without enforcing it", () => {
    const csp = parseCsp(headers["Content-Security-Policy-Report-Only"]);
    expect(csp["default-src"]).toEqual(["'self'"]);
    expect(csp["script-src"]).toEqual(["'self'", "'unsafe-inline'", JUPITER_PLUGIN_ORIGIN]);
    expect(csp["connect-src"]).toEqual(expect.arrayContaining(["'self'", "https://www.ogcato.com", "wss://www.ogcato.com", "https://*.jup.ag"]));
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
    expect(csp["object-src"]).toEqual(["'none'"]);
  });

  it("only allow eval for the dev server on site pages", () => {
    const dev = parseCsp(serializeCsp(siteReportOnlyDirectives({ NODE_ENV: "development" })));
    expect(dev["script-src"]).toContain("'unsafe-eval'");
    expect(parseCsp(headers["Content-Security-Policy-Report-Only"])["script-src"]).not.toContain("'unsafe-eval'");
  });

  it("adds configured origins without paths or query strings", () => {
    const csp = parseCsp(serializeCsp(siteReportOnlyDirectives({
      NODE_ENV: "production",
      NEXT_PUBLIC_RPC_URL: "https://api.devnet.solana.com/some/path?x=1",
      NEXT_PUBLIC_API_URL: "https://wrapped-api.example/v1",
    })));
    expect(csp["connect-src"]).toEqual(expect.arrayContaining([
      "https://api.devnet.solana.com", "wss://api.devnet.solana.com", "https://wrapped-api.example",
    ]));
    expect(csp["connect-src"].join(" ")).not.toMatch(/path|\?/);
  });

  it("gives /updown its own report-only policy and keeps the rest", () => {
    expect(updown.source).toBe("/updown/:path*");
    expect(updown.headers.map((h) => h.key)).toEqual(["Content-Security-Policy-Report-Only"]);
    const csp = parseCsp(updown.headers[0].value);
    expect(csp["script-src"]).not.toContain("'unsafe-inline'");
    expect(parseCsp(serializeCsp(updownReportOnlyDirectives(prod)))).toEqual(csp);
    expect(csp["frame-ancestors"]).toEqual(["'none'"]);
  });
});

describe("next.config.mjs headers()", () => {
  it("puts the site-wide rule first and keeps the claw texture cache rules", async () => {
    const rules = (await nextConfig.headers!()) as Rule[];
    expect(rules[0].source).toBe("/:path*");
    expect(headerMap(rules[0])["X-Frame-Options"]).toBe("DENY");
    const textures = rules.filter((r) => r.source.startsWith("/claw/concrete-"));
    expect(textures).toHaveLength(3);
    for (const rule of textures) {
      expect(headerMap(rule)["Cache-Control"]).toBe("public, max-age=31536000, immutable");
    }
  });
});

describe("Jupiter plugin script", () => {
  it("is loaded by the swap widget only, from the allowlisted origin", () => {
    const swap = readFileSync(resolve(web, "components/JupiterSwap.tsx"), "utf8");
    const layout = readFileSync(resolve(web, "app/layout.tsx"), "utf8");
    const src = swap.match(/JUPITER_PLUGIN_SRC = "([^"]+)"/)?.[1];
    expect(src && new URL(src).origin).toBe(JUPITER_PLUGIN_ORIGIN);
    expect(layout).not.toMatch(/plugin\.jup\.ag|next\/script/);
  });
});
