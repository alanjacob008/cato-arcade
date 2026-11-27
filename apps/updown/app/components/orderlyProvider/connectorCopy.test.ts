// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultNS, en, i18n } from "@orderly.network/i18n";
import { CONNECTOR_COPY, TRADING_JARGON, withConnectorCopy } from "./connectorCopy";

const sdkEn = en as Record<string, string>;
const placeholders = (text: string) => new Set(text.match(/\{\{\s*\w+\s*\}\}/g) ?? []);

describe("wallet dialog copy overrides", () => {
  it("only rewrites keys the SDK has, and changes each of them", () => {
    for (const [key, text] of Object.entries(CONNECTOR_COPY)) {
      expect(sdkEn[key], key).toBeTypeOf("string");
      expect(text, key).not.toBe(sdkEn[key]);
      expect(text.trim(), key).not.toBe("");
    }
  });

  it("speaks about playing, never trading", () => {
    for (const [key, text] of Object.entries(CONNECTOR_COPY)) {
      expect(text, key).not.toMatch(TRADING_JARGON);
    }
    // The SDK's own strings are what we are replacing, so the regex must catch them.
    expect(sdkEn["connector.enableTrading"]).toMatch(TRADING_JARGON);
    expect(sdkEn["connector.enableTrading.description"]).toMatch(TRADING_JARGON);
  });

  it("only uses {{placeholders}} the SDK passes for that key", () => {
    for (const [key, text] of Object.entries(CONNECTOR_COPY)) {
      const available = placeholders(sdkEn[key]);
      for (const name of placeholders(text)) expect(available.has(name), `${key} ${name}`).toBe(true);
    }
  });

  it("makes the SDK's i18n instance return the new strings", async () => {
    await i18n.changeLanguage("en");
    i18n.addResourceBundle("en", defaultNS, withConnectorCopy({}), true, true);
    expect(i18n.t("connector.createAccount")).toBe("Set up your account");
    expect(i18n.t("connector.enableTrading")).toBe("Start playing");
    expect(i18n.t("connector.rememberMe")).toBe("Remember me");
    expect(i18n.t("connector.connectWallet")).toBe("Connect wallet");
  });

  it("every key is still rendered by @orderly.network/ui-connector (SDK upgrade canary)", () => {
    const require = createRequire(import.meta.url);
    const dist = dirname(require.resolve("@orderly.network/ui-connector/package.json"));
    const files = readdirSync(join(dist, "dist"), { recursive: true }) as string[];
    const source = files
      .filter((f) => f.endsWith(".js"))
      .map((f) => readFileSync(join(dist, "dist", f), "utf8"))
      .join("\n");
    for (const key of Object.keys(CONNECTOR_COPY)) {
      expect(source.includes(`"${key}"`), key).toBe(true);
    }
  });
});
