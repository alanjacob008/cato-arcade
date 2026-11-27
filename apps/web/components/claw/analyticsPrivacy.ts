/** Report the public game route without query strings or URL fragments. */
export function clawAnalyticsUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.pathname !== "/claw" && url.pathname !== "/claw/") return null;
    url.pathname = "/claw";
    url.search = "";
    url.hash = "";
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return null;
  }
}
