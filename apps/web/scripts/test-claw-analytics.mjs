import assert from "node:assert/strict";
import { clawModule } from "./claw-test-loader.mjs";
const { clawAnalyticsUrl } = await import(await clawModule("analyticsPrivacy"));

assert.equal(clawAnalyticsUrl("https://cato-claw-arcade.vercel.app/claw?wallet=private&perf=1#token"), "https://cato-claw-arcade.vercel.app/claw");
assert.equal(clawAnalyticsUrl("https://example.com/claw/"), "https://example.com/claw");
assert.equal(clawAnalyticsUrl("https://user:secret@example.com/claw"), "https://example.com/claw");
for (const path of ["/claw/lab", "/api/claw", "/claw/other", "/"]) assert.equal(clawAnalyticsUrl(`https://example.com${path}`), null);
for (const invalid of ["", "/claw", "not a URL"]) assert.equal(clawAnalyticsUrl(invalid), null);
console.log("PASS: traffic analytics strips query strings, fragments and credentials; lab and non-game routes are excluded.");
