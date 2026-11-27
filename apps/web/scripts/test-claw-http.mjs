import assert from "node:assert/strict";

const base = new URL(process.argv[2] ?? "http://127.0.0.1:3000");
const production = process.argv[3] === "production";
assert(["localhost", "127.0.0.1", "[::1]"].includes(base.hostname), "Smoke tests must target a local server");

for (const path of ["/claw", "/claw/lab"]) {
  const response = await fetch(new URL(path, base), { signal: AbortSignal.timeout(30000) });
  assert.equal(response.status, production && path.endsWith("/lab") ? 404 : 200, path);
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.equal(response.headers.get("x-powered-by"), null);
  assert.equal(response.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
  assert.equal(response.headers.get("permissions-policy"), "camera=(), microphone=(), geolocation=()");
  const csp = response.headers.get("content-security-policy");
  for (const directive of ["frame-ancestors 'none'", "object-src 'none'", "base-uri 'self'"]) assert(csp?.includes(directive));
}
for (const font of ["BricolageGrotesque.woff2", "Rubik.woff2", "pixel-sans-serif.ttf", "tt-prosto-sans-bold.otf"]) {
  assert.equal((await fetch(new URL(`/claw/fonts/${font}`, base))).status, 200, font);
}
assert.equal((await fetch(new URL("/claw/cato-brand-logo.png", base))).status, 200, "The supplied CATO brand logo is available");
for (const file of ["concrete-diffuse-v2.webp", "concrete-normal-v2.webp", "concrete-arm-v2.webp"]) assert.equal((await fetch(new URL(`/claw/${file}`, base))).status, 200, "Scanned concrete PBR maps are available");
for (const path of ["/claw/audio/pixel-jackpot-claw.mp3", "/claw/cato-symmetric.glb", "/claw/cato-concept.png", "/claw/fonts/tt-bricks-regular.otf", "/claw/wet-asphalt.webp", "/claw/concrete-pavement.webp"]) {
  assert.equal((await fetch(new URL(path, base))).status, 404, "Removed assets must not be publicly served");
}
assert.equal((await fetch(base)).status, 200, "The game entry route must load");
console.log(`PASS: ${production ? "production lab disabled" : "player and lab available"}, HTTP security headers, active fonts, removed assets unavailable, game entry route available.`);
