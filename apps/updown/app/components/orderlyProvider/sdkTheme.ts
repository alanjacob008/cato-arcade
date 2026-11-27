import type { DexThemeConfig } from "@/utils/theme-config";

/**
 * Orderly's stylesheet consumes colour variables as space-separated RGB
 * channels, e.g. `rgb(var(--oui-color-base-8) / 0.5)`. A hex value such as
 * `#161616` makes that declaration invalid, so every `oui-bg-*`, `oui-text-*`
 * and `oui-border-*` utility silently resolves to transparent (the chain
 * picker, wallet menu and dialogs lost their backgrounds).
 *
 * Our theme config stays readable hex; this converts colour and gradient
 * variables to channel triplets right before they reach the SDK.
 */
const CHANNEL_VARS = /^--oui-(color|gradient)-/;
const HEX = /^#([\da-f]{3}|[\da-f]{6})$/i;

export function hexToChannels(value: string): string {
  const match = value.trim().match(HEX);
  if (!match) return value;
  const hex =
    match[1].length === 3
      ? match[1]
          .split("")
          .map((c) => c + c)
          .join("")
      : match[1];
  return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");
}

export function toSdkCssVars<T extends Record<string, string | undefined>>(
  cssVars: T,
): T {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(cssVars)) {
    out[key] =
      typeof value === "string" && CHANNEL_VARS.test(key)
        ? hexToChannels(value)
        : value;
  }
  return out as T;
}

export function toSdkThemes(themes: DexThemeConfig): DexThemeConfig {
  return themes.map((theme) =>
    theme.cssVars ? { ...theme, cssVars: toSdkCssVars(theme.cssVars) } : theme,
  );
}
