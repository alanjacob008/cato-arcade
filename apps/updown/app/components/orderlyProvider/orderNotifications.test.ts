// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { defaultNS, en, i18n } from "@orderly.network/i18n";
import { SUPPRESSED_SDK_MESSAGES, withSuppressedNotifications } from "./orderNotifications";

const FILLED_TITLE = "orders.status.filled.toast.title";

describe("order-filled toast suppression", () => {
  it("blanks only the filled toast title and keeps other order and error messages", () => {
    expect(Object.keys(SUPPRESSED_SDK_MESSAGES)).toEqual([FILLED_TITLE]);
    const merged = withSuppressedNotifications({ [FILLED_TITLE]: "Order filled", "orders.status.rejected.toast.title": "Order rejected" });
    expect(merged[FILLED_TITLE]).toBe("");
    expect(merged["orders.status.rejected.toast.title"]).toBe("Order rejected");
  });

  it("makes the SDK's i18n instance translate the filled title to an empty string", async () => {
    expect((en as Record<string, string>)[FILLED_TITLE]).toBe("Order filled");
    await i18n.changeLanguage("en");
    i18n.addResourceBundle("en", defaultNS, withSuppressedNotifications({}), true, true);
    expect(i18n.t(FILLED_TITLE)).toBe("");
    expect(i18n.t("orders.status.rejected.toast.title")).not.toBe("");
  });

  it("still relies on the SDK skipping toasts with an empty title (SDK upgrade canary)", () => {
    const require = createRequire(import.meta.url);
    const source = readFileSync(require.resolve("@orderly.network/react-app").replace(/index\.js$/, "index.mjs"), "utf8");
    const listener = source.slice(source.indexOf("var useExecutionReport"), source.indexOf("function useUILocale"));
    expect(listener).toContain('ee.on("orders:changed"');
    expect(source).toContain(`title = i18n.t("${FILLED_TITLE}")`);
    expect(listener).toMatch(/if \(title && msg\) \{\s*toast\.success\(/);
  });
});
