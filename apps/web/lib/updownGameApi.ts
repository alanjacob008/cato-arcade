/**
 * /game-api/* inside the website (Node runtime). The site's signed session
 * cookie is the authentication; every round read and operation is limited to the
 * Orderly account of the session's wallet. Rounds advance on players' polls here
 * and on the cron sweep (updownSweep.ts); there is no long-running worker.
 */
import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, openSession } from "./updownSession";
import { accountAuthorizer } from "./updownAccounts";
import { UpdownConfigError, getUpdownRuntime, previewRefusal, updownConfig, updownEnabled, type UpdownRuntime } from "./updownRuntime";

const MAX_BODY = 16_384;
const noStore = { "Cache-Control": "no-store" };
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, { status, headers: { ...noStore, ...headers } });

/**
 * Same-origin protection: the cookie is SameSite=Lax already; additionally refuse
 * anything a browser labels cross-site and any Origin that is not this site.
 * Returns the reason to refuse, or null.
 */
export function crossSiteRejection(req: NextRequest): string | null {
  if (req.headers.get("sec-fetch-site") === "cross-site") return "Cross-site requests rejected.";
  const origin = req.headers.get("origin");
  if (origin && origin !== req.nextUrl.origin) {
    // Behind a proxy (Vercel) the forwarded host is the public one.
    const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
    const proto = req.headers.get("x-forwarded-proto") ?? req.nextUrl.protocol.replace(":", "");
    if (!host || origin !== `${proto}://${host}`) return "Origin rejected.";
  }
  if (req.method === "POST" && !req.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    return "Requests must be JSON.";
  }
  return null;
}

async function readJson(req: NextRequest): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error("Request too large.");
  // Never echo the parser's message: it quotes the request body back.
  try {
    return JSON.parse(text || "{}");
  } catch {
    throw new Error("Invalid JSON.");
  }
}

export interface GameApiDeps {
  runtime?: () => Promise<UpdownRuntime>;
  env?: NodeJS.ProcessEnv;
}

export async function handleGameApi(req: NextRequest, deps: GameApiDeps = {}): Promise<NextResponse> {
  const env = deps.env ?? process.env;
  if (!updownEnabled(env)) {
    return json({ error: "Up Down is coming online soon." }, 503, { "Retry-After": "300" });
  }
  const refusal = crossSiteRejection(req);
  if (refusal) return json({ error: refusal }, 403);
  // Configuration problems that no request can fix: an unknown network value, or
  // mainnet on a preview deployment (UPDOWN_ALLOW_PREVIEW_MAINNET opts in).
  let unavailable: string | null;
  try {
    updownConfig(env);
    unavailable = previewRefusal(env);
  } catch (error) {
    unavailable = error instanceof UpdownConfigError ? error.message : "The round service is misconfigured.";
  }
  if (unavailable) return json({ error: unavailable }, 503);
  // middleware.ts already turned away requests without a session; this reads the wallet.
  const session = await openSession(req.cookies.get(SESSION_COOKIE)?.value);
  if (!session) return json({ error: "Sign in to play." }, 401);

  const pathname = req.nextUrl.pathname;
  // The local worker hands out a token here; the website needs none (the cookie authenticates).
  if (req.method === "GET" && pathname === "/game-api/session") {
    return json({ network: updownConfig(env).network, wallet: session.wallet });
  }

  let runtime: UpdownRuntime;
  try {
    runtime = await (deps.runtime ?? (() => getUpdownRuntime(env)))();
  } catch (error) {
    const message = error instanceof UpdownConfigError ? error.message : "The round service is unavailable. Try again shortly.";
    console.error(`Up Down: round service failed to start: ${(error as Error)?.message ?? error}`);
    return json({ error: message }, 503, { "Retry-After": "30" });
  }
  const authorize = accountAuthorizer(session.wallet, { request: runtime.request, brokerId: runtime.config.brokerId });
  try {
    const result = await runtime.api({
      method: req.method,
      pathname,
      searchParams: req.nextUrl.searchParams,
      readBody: () => readJson(req),
      authorize,
    });
    return json(result.body, result.status);
  } catch (error) {
    console.error(`Up Down: game API error: ${(error as Error)?.message ?? error}`);
    return json({ error: "The round service could not complete this request." }, 500);
  }
}
