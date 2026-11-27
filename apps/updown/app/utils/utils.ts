export const SITE_TITLE = "Up Down";

/** "Play" -> "Play · Up Down" (matches index.html's base title). */
export function generatePageTitle(title: string) {
  return `${title} · ${SITE_TITLE}`;
}

export function formatSymbol(symbol: string, format = "base-type") {
  const arr = symbol.split("_");
  const type = arr[0];
  const base = arr[1];
  const quote = arr[2];

  return format
    .replace("type", type)
    .replace("base", base)
    .replace("quote", quote);
}
