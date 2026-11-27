import { act } from "react";
import { createRoot, Root } from "react-dom/client";
import { Simulate } from "react-dom/test-utils";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToChannels, toSdkThemes } from "./orderlyProvider/sdkTheme";
import {
  SOLANA_DEFAULT_CHAIN,
  resetAutoSelectedChainOnce,
} from "./orderlyProvider/defaultChain";
import { catoThemes } from "@/utils/cato-theme";

vi.mock("@orderly.network/ui-scaffold", () => ({
  // Like the SDK's desktop chain picker: a Radix menu trigger rendered as a <div>.
  ChainMenuWidget: () => (
    <div data-testid="chain-menu" aria-haspopup="menu" aria-expanded="false">
      chain
    </div>
  ),
  AccountMenuWidget: () => <button data-testid="account-menu">Connect wallet</button>,
}));

const wallet = vi.hoisted(() => ({
  state: { status: 0, validating: false } as {
    status: number;
    validating: boolean;
    address?: string;
    connectWallet?: { name: string; chainId: number };
  },
  wrongNetwork: false,
  disabledConnect: false,
  walletDisconnect: vi.fn(async () => []),
  accountDisconnect: vi.fn(async () => undefined),
}));
vi.mock("@orderly.network/hooks", () => ({
  useAccount: () => ({
    state: wallet.state,
    account: { disconnect: wallet.accountDisconnect },
  }),
  useWalletConnector: () => ({ disconnect: wallet.walletDisconnect }),
}));
vi.mock("@orderly.network/react-app", () => ({
  useAppContext: () => ({
    wrongNetwork: wallet.wrongNetwork,
    disabledConnect: wallet.disabledConnect,
  }),
}));

const { CatoHeader, isNavItemActive, shortAddress } = await import("./CatoHeader");

const SOLANA_ADDRESS = "7xKqAbCdEfGhJkLmNpQrStUvWxYz123456789Xy3fPq";

let container: HTMLDivElement, root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  wallet.state = { status: 0, validating: false };
  wallet.wrongNetwork = false;
  wallet.disabledConnect = false;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});


const renderAt = (path: string) =>
  act(() =>
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <CatoHeader />
      </MemoryRouter>,
    ),
  );

describe("CatoHeader", () => {
  it("mirrors the main site: wordmark, nav, Docs and Socials, plus chain + wallet only", () => {
    renderAt("/");
    expect(container.querySelector(".cato-header-brand")?.textContent).toBe("First CAT on Solana");
    const links = [...container.querySelectorAll(".cato-header-link")].map((el) => el.textContent);
    expect(links).toEqual(["Staking", "Swap", "Wrapped", "VIP", "Docs ↗", "Socials ▾"]);
    expect(container.querySelector('[data-testid="chain-menu"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="account-menu"]')).not.toBeNull();
    // Removed from the old SDK header.
    expect(container.textContent).not.toMatch(/Total value|MAINNET|TESTNET/);
  });

  it("keeps VIP highlighted on every game screen, like the main site does for its active page", () => {
    renderAt("/portfolio/assets");
    const active = container.querySelector('[aria-current="page"]');
    expect(active?.textContent).toBe("VIP");
    expect(isNavItemActive("/", "/")).toBe(true);
    expect(isNavItemActive("/", "/portfolio")).toBe(false);
    expect(isNavItemActive("/portfolio", "/portfolios")).toBe(false);
  });

  it("opens and closes the socials menu", () => {
    renderAt("/");
    const button = container.querySelector<HTMLButtonElement>(".cato-header-socials-button")!;
    act(() => Simulate.click(button));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll('[role="menuitem"]')).toHaveLength(4);
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("header accessibility", () => {
  it("makes the SDK's <div> chain trigger keyboard-reachable and named", () => {
    renderAt("/");
    const trigger = container.querySelector<HTMLElement>('[data-testid="chain-menu"]')!;
    expect(trigger.tabIndex).toBe(0);
    expect(trigger.getAttribute("role")).toBe("button");
    expect(trigger.getAttribute("aria-label")).toBe("Switch network");
  });

  it("returns focus to the chain trigger when its menu closes", async () => {
    renderAt("/");
    const trigger = container.querySelector<HTMLElement>('[data-testid="chain-menu"]')!;
    trigger.setAttribute("aria-expanded", "true");
    await act(async () => undefined);
    (document.activeElement as HTMLElement | null)?.blur();
    trigger.setAttribute("aria-expanded", "false");
    await act(async () => undefined); // flush MutationObserver
    expect(document.activeElement).toBe(trigger);
  });

  it("flags the nav edges that hide overflowing links", () => {
    renderAt("/");
    const header = container.querySelector<HTMLElement>(".cato-header")!;
    const nav = container.querySelector<HTMLElement>(".cato-header-nav")!;
    Object.defineProperty(nav, "scrollWidth", { configurable: true, value: 400 });
    Object.defineProperty(nav, "clientWidth", { configurable: true, value: 300 });
    act(() => {
      nav.dispatchEvent(new Event("scroll"));
    });
    expect(header.hasAttribute("data-nav-overflow-end")).toBe(true);
    expect(header.hasAttribute("data-nav-overflow-start")).toBe(false);
    nav.scrollLeft = 100;
    act(() => {
      nav.dispatchEvent(new Event("scroll"));
    });
    expect(header.hasAttribute("data-nav-overflow-end")).toBe(false);
    expect(header.hasAttribute("data-nav-overflow-start")).toBe(true);
  });

  it("titles pages as '<Page> · Up Down'", async () => {
    const { generatePageTitle } = await import("@/utils/utils");
    expect(generatePageTitle("Balances")).toBe("Balances · Up Down");
  });
});

describe("header wallet control", () => {
  const connect = () => {
    wallet.state = {
      status: 5, // AccountStatusEnum.EnableTrading
      validating: false,
      address: SOLANA_ADDRESS,
      connectWallet: { name: "Phantom", chainId: 900900900 },
    };
  };

  it("shortens addresses to first 4 + last 4", () => {
    expect(shortAddress(SOLANA_ADDRESS)).toBe("7xKq…3fPq");
    expect(shortAddress("0x12345678")).toBe("0x12345678");
  });

  it("uses the SDK account widget until trading is enabled", () => {
    wallet.state = { status: 2, validating: false, address: SOLANA_ADDRESS };
    renderAt("/");
    expect(container.querySelector('[data-testid="account-menu"]')).not.toBeNull();
    expect(container.querySelector(".cato-wallet-button")).toBeNull();
  });

  it("falls back to the SDK widget on a wrong network or while validating", () => {
    connect();
    wallet.wrongNetwork = true;
    renderAt("/");
    expect(container.querySelector('[data-testid="account-menu"]')).not.toBeNull();
    wallet.wrongNetwork = false;
    wallet.state = { ...wallet.state, validating: true };
    renderAt("/");
    expect(container.querySelector('[data-testid="account-menu"]')).not.toBeNull();
  });

  it("renders the connected address as a sized button with icon and chevron", () => {
    connect();
    renderAt("/");
    expect(container.querySelector('[data-testid="account-menu"]')).toBeNull();
    const button = container.querySelector<HTMLButtonElement>(".cato-wallet-button")!;
    expect(button.querySelector(".cato-wallet-address")?.textContent).toBe("7xKq…3fPq");
    expect(button.querySelector("svg.cato-wallet-icon")).not.toBeNull();
    expect(button.querySelector("svg.cato-wallet-chevron")).not.toBeNull();
    expect(button.getAttribute("title")).toBe(SOLANA_ADDRESS);
    expect(button.getAttribute("aria-haspopup")).toBe("menu");
  });

  it("opens the wallet menu and disconnects like the SDK", async () => {
    connect();
    localStorage.setItem("orderly_link_device", "1");
    renderAt("/");
    const button = container.querySelector<HTMLButtonElement>(".cato-wallet-button")!;
    act(() => Simulate.click(button));
    expect(button.getAttribute("aria-expanded")).toBe("true");
    const items = [...container.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent);
    expect(items).toEqual(["Copy address", "Disconnect"]);
    await act(async () => {
      Simulate.click(container.querySelector('[data-testid="cato-wallet-disconnect"]')!);
    });
    expect(wallet.walletDisconnect).toHaveBeenCalledWith({ label: "Phantom" });
    expect(wallet.accountDisconnect).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("orderly_link_device")).toBeNull();
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});

describe("SDK theme variables", () => {
  it("converts hex colours to the RGB channel triplets Orderly's CSS expects", () => {
    expect(hexToChannels("#161616")).toBe("22 22 22");
    expect(hexToChannels("#fea")).toBe("255 238 170");
    expect(hexToChannels("not-a-colour")).toBe("not-a-colour");
    const vars = toSdkThemes(catoThemes)[0].cssVars!;
    expect(vars["--oui-color-base-8"]).toBe("22 22 22");
    expect(vars["--oui-gradient-brand-end"]).toBe("254 169 17");
    // Non-colour variables are untouched; the source theme stays hex.
    expect(vars["--oui-rounded"]).toBe("6px");
    expect(vars["--oui-font-family"]).toContain("Rubik");
    expect(catoThemes[0].cssVars!["--oui-color-base-8"]).toBe("#161616");
  });
});

describe("default chain", () => {
  it("is Solana mainnet / devnet", () => {
    expect(SOLANA_DEFAULT_CHAIN).toEqual({
      mainnet: { id: 900900900 },
      testnet: { id: 901901901 },
    });
  });

  it("clears an auto-selected non-Solana chain exactly once", () => {
    localStorage.clear();
    localStorage.setItem("order:chain", JSON.stringify({ chainId: 42161, namespace: "EVM" }));
    resetAutoSelectedChainOnce(localStorage);
    expect(localStorage.getItem("order:chain")).toBeNull();
    // A later explicit choice survives.
    localStorage.setItem("order:chain", JSON.stringify({ chainId: 42161, namespace: "EVM" }));
    resetAutoSelectedChainOnce(localStorage);
    expect(localStorage.getItem("order:chain")).not.toBeNull();
  });

  it("keeps a stored Solana chain", () => {
    localStorage.clear();
    const solana = JSON.stringify({ chainId: 900900900, namespace: "SOL" });
    localStorage.setItem("order:chain", solana);
    resetAutoSelectedChainOnce(localStorage);
    expect(localStorage.getItem("order:chain")).toBe(solana);
  });
});
