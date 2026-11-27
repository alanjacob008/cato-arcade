/**
 * Renders the real SDK deposit and withdraw forms (@orderly.network/ui-transfer)
 * with our copy, and checks the "Deposit / withdraw" hide rules in
 * styles/sdk-overrides.css against that DOM: they must match exactly the
 * perps-only rows and nothing players need. jsdom does not lay out or apply
 * stylesheets, so "hidden" here means "matched by a display:none selector".
 *
 * The SDK packages load from node_modules, where vi.mock cannot reach them, so
 * the forms get real SDK contexts with a stub config store, account and wallet
 * instead of mocked hooks. The form props are the script hooks' return values,
 * filled in by hand. Nothing reaches the network: the one request the forms
 * make (LTV threshold) goes to an unreachable local port.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SimpleDI } from "@orderly.network/core";
import { OrderlyContext, WalletConnectorContext } from "@orderly.network/hooks";
import { OrderlyThemeProvider, TooltipProvider } from "@orderly.network/ui";
import { DepositForm, WithdrawForm } from "@orderly.network/ui-transfer";
import { CatoBrand } from "@/components/CatoBrand";
import { PERPS_JARGON, withTransferCopy } from "./transferCopy";

const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../styles/sdk-overrides.css"), "utf8");
const transferSection = css.slice(css.lastIndexOf("/*", css.indexOf("Deposit / withdraw dialog"))).replace(/\/\*[\s\S]*?\*\//g, "");
const HIDE_SELECTORS = [...transferSection.matchAll(/([^{}]+)\{\s*display:\s*none;?\s*\}/g)].flatMap((m) =>
  m[1].split(",").map((s) => s.trim()),
);

// ui-transfer is loaded as CommonJS here, so its translations come from the
// CommonJS copy of @orderly.network/i18n, not the ESM one an import would give.
const { defaultNS, i18n } = createRequire(import.meta.url)("@orderly.network/i18n") as typeof import("@orderly.network/i18n");

const config: Record<string, unknown> = { brokerName: "Cato", brokerId: "cato", networkId: "mainnet", apiBaseUrl: "http://127.0.0.1:9" };
const configStore = { get: (k: string) => config[k], getOr: (k: string, d: unknown) => config[k] ?? d, set() {} };
const ADDRESS = "So1anaAddr1111111111111111111111111111111";

beforeAll(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = ((media: string) => ({
    matches: false, media, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  })) as unknown as typeof window.matchMedia;
  // Status 5 = EnableTrading, so AuthGuard renders the real confirm buttons.
  SimpleDI.registerByName("account", {
    stateValue: { status: 5, address: ADDRESS }, on() {}, off() {}, once() {},
    getAdditionalInfo: () => ({}), walletAdapter: { chainNamespace: "SOL" },
  });
  await i18n.changeLanguage("en");
  i18n.addResourceBundle("en", defaultNS, withTransferCopy({}), true, true);
});

let container: HTMLDivElement | undefined;
let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
});

async function render<P extends object>(Form: ComponentType<P>, props: P) {
  container = document.createElement("div");
  document.body.append(container);
  const r = createRoot(container);
  root = r;
  const wallet = { wallet: { label: "Phantom", accounts: [{ address: ADDRESS }] }, connectedChain: { id: 900900900 } };
  await act(async () =>
    r.render(
      <OrderlyContext.Provider value={{ configStore, keyStore: {}, walletAdapters: [] } as never}>
        <WalletConnectorContext.Provider value={wallet as never}>
          <OrderlyThemeProvider>
            <TooltipProvider>
              <Form {...props} />
            </TooltipProvider>
          </OrderlyThemeProvider>
        </WalletConnectorContext.Provider>
      </OrderlyContext.Provider>,
    ),
  );
  return container;
}

const hiddenBy = (el: Element) => HIDE_SELECTORS.some((sel) => el.closest(sel));
const hiddenRows = (rootEl: Element) =>
  HIDE_SELECTORS.flatMap((sel) => [...rootEl.querySelectorAll(sel)]).map((el) => el.textContent?.replace(/\s+/g, " ").trim());
function visibleText(rootEl: Element) {
  const walker = document.createTreeWalker(rootEl, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement && !hiddenBy(node.parentElement)) parts.push(node.textContent ?? "");
  }
  return parts.join(" ").replace(/\s+/g, " ");
}
const expectShown = (el: Element | null | undefined) => {
  expect(el).toBeTruthy();
  expect(hiddenBy(el as Element)).toBe(false);
};
const byText = (rootEl: Element, text: string) =>
  [...rootEl.querySelectorAll("span,button")].find((el) => el.textContent?.trim() === text);

const usdc = { symbol: "USDC", precision: 6, decimals: 6, address: "usdc", is_collateral: true, user_max_qty: -1 };
const solana = { id: 900900900, namespace: "SOL", info: { network_infos: { name: "Solana", chain_id: 900900900 } } };
const noop = () => undefined;
const asyncNoop = async () => undefined;

type DepositProps = Parameters<typeof DepositForm>[0];
type WithdrawProps = Parameters<typeof WithdrawForm>[0];

const depositProps = {
  sourceToken: usdc, targetToken: usdc, sourceTokens: [usdc], targetTokens: [usdc], usdcToken: usdc,
  onSourceTokenChange: noop, onTargetTokenChange: noop, nativeSymbol: "SOL", isNativeToken: false,
  quantity: "10", targetQuantity: "10", collateralContributionQuantity: 10, maxQuantity: "100", maxDepositAmount: "100",
  onQuantityChange: noop, hintMessage: "", inputStatus: "default", targetInputStatus: "default", targetHintMessage: "",
  chains: [solana.info.network_infos], currentChain: solana, settingChain: false, onChainChange: asyncNoop,
  actionType: 0, onDeposit: asyncNoop, onApprove: asyncNoop, onApproveAndDeposit: asyncNoop, wrongNetwork: false,
  balanceRevalidating: false, batchBalancesRevalidating: false, loading: false, disabled: false, networkId: "mainnet",
  fee: { dstGasFee: "0.001", feeQty: "0.001", feeAmount: "0.2", dp: 4 },
  collateralRatio: 1, currentLTV: 0, nextLTV: 0, ltv_threshold: 0.8, negative_usdc_threshold: 0, isConvertThresholdLoading: false,
  slippage: 1, onSlippageChange: noop, slippageValidate: () => "", swapMinReceived: undefined, needSwap: false,
  swapPrice: undefined, swapPriceInUSD: undefined, warningMessage: undefined, targetQuantityLoading: false, isLoggedIn: true,
  showSourceDepositCap: false, showTargetDepositCap: false, quantityNotional: 10, activeSubTab: "web3",
  setActiveSubTab: noop, showExclusiveDeposit: false,
} as unknown as DepositProps;

const withdrawProps = {
  withdrawTo: "wallet", setWithdrawTo: noop, currentLTV: 0, nextLTV: 0, warningMessage: "", isLoggedIn: true,
  isTokenUnsupported: false, onSwitchToSupportedNetwork: asyncNoop, enableWithdrawToExternalWallet: false,
  externalWallets: [], selectedWalletAddress: ADDRESS, onSelectWallet: noop, onAddExternalWallet: noop, setExternalWallets: noop,
  isEnableTrading: true, toAccountId: "", setToAccountId: noop, onTransfer: noop, internalWithdrawSubmitting: false,
  toAccountIdInputStatus: "default", toAccountIdHintMessage: undefined, toAccountInfo: null,
  toAccountInfoDropdownOpen: false, setToAccountInfoDropdownOpen: noop, walletName: "Phantom", address: ADDRESS,
  quantity: "10", onQuantityChange: noop, sourceToken: usdc, onSourceTokenChange: noop, sourceTokens: [usdc],
  inputStatus: "default", hintMessage: undefined, amount: 10, balanceRevalidating: false, maxQuantity: 100,
  disabled: false, loading: false, unsettledPnL: 1.5, wrongNetwork: false, settingChain: false,
  tokenChains: [{ ...solana.info.network_infos, isSupported: true }], currentChain: solana, onChainChange: asyncNoop,
  onWithdraw: asyncNoop, fee: 1, crossChainWithdraw: false, crossChainTrans: false, showQty: "9", networkId: "mainnet",
  checkIsBridgeless: true, hasPositions: true, onSettlePnl: asyncNoop, brokerName: "Cato", qtyGreaterThanMaxAmount: false,
  vaultBalanceList: [],
} as unknown as WithdrawProps;

describe("sdk-overrides.css: deposit / withdraw dialog", () => {
  it("has hide rules, all scoped to the transfer forms", () => {
    expect(HIDE_SELECTORS.length).toBeGreaterThanOrEqual(3);
    for (const sel of HIDE_SELECTORS) expect(sel).toMatch(/^#oui-(deposit|withdraw)-form\b/);
  });

  it("deposit: hides the summary rows and the mirrored destination block; keeps what players need", async () => {
    const form = (await render(DepositForm, depositProps)).querySelector("#oui-deposit-form");
    expect(form).toBeTruthy();
    expect(hiddenRows(form!)).toEqual([
      "Counts toward balance100.00%",
      "Added to your balance10USDC",
      expect.stringMatching(/^Owed vs\. balance/),
      "AmountUSDC", // read-only destination input (its value is not text)
      "Your account balance",
      "", // down-arrow divider (svg only)
    ]);

    // Destination block: read-only input, "Your account balance" row, divider.
    const inputs = [...form!.querySelectorAll("input")];
    expect(inputs).toHaveLength(2);
    const destination = inputs.find((input) => input.readOnly)!;
    expect(destination.value).toBe("10");
    expect(hiddenBy(destination)).toBe(true);
    const brokerRow = byText(form!, "Your account balance")!;
    expect(hiddenBy(brokerRow)).toBe(true);
    expect(hiddenBy(brokerRow.parentElement!.previousElementSibling!)).toBe(true);
    expect(brokerRow.parentElement!.previousElementSibling!.querySelector("svg")).toBeTruthy();

    // Kept: source input, Max, network, fee, button. Nothing next to them hidden.
    const source = form!.querySelector('[data-testid="oui-testid-deposit-dialog-quantity-input"]');
    expect(source).toBe(inputs.find((input) => !input.readOnly));
    expectShown(source);
    expectShown(form!.querySelector('[data-testid="oui-testid-deposit-dialog-deposit-btn"]'));
    expectShown(byText(form!, "Max"));
    expectShown(byText(form!, "Network"));
    expectShown(byText(form!, "Solana"));
    expectShown([...form!.querySelectorAll("span")].find((el) => el.textContent?.startsWith("Network fee")));
    const text = visibleText(form!);
    expect(text).toMatch(
      /^From your wallet Your wallet .* Network Solana Amount USDC \$ 10 Available: 100 USDC Max Network fee ≈ \$ ?0\.2 .*SOL \) Deposit$/,
    );
    expect(text).not.toMatch(/Your account balance|Cato|Up Down/);
    expect(text).not.toMatch(PERPS_JARGON);
  });

  it("withdraw: hides LTV and the other-account tab; keeps settle, fee and the confirm button", async () => {
    const form = (await render(WithdrawForm, withdrawProps)).querySelector("#oui-withdraw-form");
    expect(form).toBeTruthy();
    // The account row renders appIcons.secondary (our <CatoBrand compact />) on
    // its right. That comes from OrderlyAppProvider's config, which these stub
    // contexts cannot supply, so put the same markup where the SDK puts it.
    const accountRow = byText(form!, "Your account balance")!.parentElement!;
    accountRow.insertAdjacentHTML("beforeend", renderToStaticMarkup(<CatoBrand compact />));
    expect(accountRow.querySelector(".cato-brand")?.textContent).toBe("Up Down");

    expect(hiddenRows(form!)).toEqual([
      expect.stringMatching(/^Owed vs\. balance/),
      "Another account",
      "Up Down",
    ]);
    expectShown(accountRow);

    // QuantityInput forwards `testId` as a plain `testid` attribute.
    expectShown(form!.querySelector('input[testid="oui-testid-withdraw-dialog-quantity-input"]'));
    expectShown(form!.querySelector('[data-testid="oui-testid-withdraw-dialog-withdraw-btn"]'));
    expectShown(form!.querySelector('[data-testid="oui-testid-withdraw-dialog-settle-text"]'));
    expectShown(form!.querySelector('[role="tab"][id$="-trigger-wallet"]'));
    expectShown(byText(form!, "Max"));
    const text = visibleText(form!);
    expect(text).toContain("Your account balance");
    expect(text).not.toMatch(/Cato balance|Cato account|Up Down/i);
    expect(text).toContain("To your wallet");
    expect(text).toContain("Results still settling:");
    expect(text).toContain("Settle now");
    expect(text).toMatch(/Network fee ≈ 1/);
    expect(text).not.toMatch(PERPS_JARGON);
  });
});
