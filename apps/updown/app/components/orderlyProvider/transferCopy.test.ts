// @vitest-environment node
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { defaultNS, en, i18n } from "@orderly.network/i18n";
import { withSuppressedNotifications } from "./orderNotifications";
import { PERPS_JARGON, TRANSFER_COPY, withTransferCopy } from "./transferCopy";

const sdkEn = en as Record<string, string>;
const placeholders = (text: string) => new Set(text.match(/\{\{\s*\w+\s*\}\}/g) ?? []);

describe("deposit / withdraw copy overrides", () => {
  it("only rewrites keys the SDK has, and changes each of them", () => {
    for (const [key, text] of Object.entries(TRANSFER_COPY)) {
      expect(sdkEn[key], key).toBeTypeOf("string");
      expect(text, key).not.toBe(sdkEn[key]);
      expect(text.trim(), key).not.toBe("");
    }
  });

  it("contains no perps jargon", () => {
    for (const [key, text] of Object.entries(TRANSFER_COPY)) {
      expect(text, key).not.toMatch(PERPS_JARGON);
    }
    for (const word of ["collateral", "LTV", "haircut", "margin", "funding"]) {
      for (const text of Object.values(TRANSFER_COPY)) expect(text.toLowerCase()).not.toContain(word.toLowerCase());
    }
  });

  it("only uses {{placeholders}} the SDK passes for that key", () => {
    for (const [key, text] of Object.entries(TRANSFER_COPY)) {
      const available = placeholders(sdkEn[key]);
      for (const name of placeholders(text)) expect(available.has(name), `${key} ${name}`).toBe(true);
    }
  });

  it("merges over the app's English bundle without touching other keys", () => {
    const merged = withSuppressedNotifications(withTransferCopy({ "extend.swap": "Swap", "common.quantity": "Quantity" }));
    expect(merged["extend.swap"]).toBe("Swap");
    expect(merged["common.quantity"]).toBe("Amount");
    expect(merged["orders.status.filled.toast.title"]).toBe("");
  });

  it("makes the SDK's i18n instance return the new strings", async () => {
    await i18n.changeLanguage("en");
    expect(i18n.t("settle.unsettled")).toBe("Unsettled");
    i18n.addResourceBundle("en", defaultNS, withSuppressedNotifications(withTransferCopy({})), true, true);
    expect(i18n.t("settle.unsettled")).toBe("Results still settling");
    expect(i18n.t("transfer.deposit.estGasFee")).toBe("Network fee");
    expect(i18n.t("transfer.brokerAccount", { brokerName: "Cato" })).toBe("Your account balance");
    expect(i18n.t("transfer.withdraw.otherAccount", { brokerName: "Cato" })).toBe("Another account");
    expect(i18n.t("transfer.deposit.notEnoughGas", { token: "SOL" })).toBe(
      "Add a little SOL to your wallet to pay the network fee.",
    );
    // Untouched keys keep the SDK text.
    expect(i18n.t("common.deposit")).toBe("Deposit");
    expect(i18n.t("common.withdraw")).toBe("Withdraw");
  });

  it("every key is still rendered by @orderly.network/ui-transfer (SDK upgrade canary)", () => {
    const require = createRequire(import.meta.url);
    const source = readFileSync(require.resolve("@orderly.network/ui-transfer").replace(/index\.js$/, "index.mjs"), "utf8");
    for (const key of Object.keys(TRANSFER_COPY)) {
      expect(source.includes(`"${key}"`), key).toBe(true);
    }
  });
});
