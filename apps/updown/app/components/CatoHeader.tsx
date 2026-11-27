import { type RefObject, useCallback, useEffect, useRef, useState } from "react";

import { useAccount, useWalletConnector } from "@orderly.network/hooks";
import { useAppContext } from "@orderly.network/react-app";
import { AccountStatusEnum } from "@orderly.network/types";
import {
  AccountMenuWidget,
  ChainMenuWidget,
} from "@orderly.network/ui-scaffold";
import { Check, ChevronDown, Copy, LogOut, Wallet } from "lucide-react";
import { getRuntimeConfig } from "@/utils/runtime-config";
import { CATO_SITE_WORDMARK, CatoSiteBrand } from "./CatoBrand";

/**
 * Mirrors the main Cato site header (apps/web/components/Header.tsx):
 * wordmark left, text-button nav right, "Docs ↗" and a "Socials ▾" menu.
 * The only additions are Orderly's chain selector and wallet button.
 * The wallet button is the SDK's AccountMenuWidget for every pre-connected
 * state (connect / create account / enable trading / wrong network); once
 * trading is enabled we render our own address trigger + menu (WalletControl),
 * because the SDK's connected button can't be sized or reformatted.
 * Rendered through the Scaffold `topBar` slot, so the SDK's account summary,
 * sub-account, link-device and QR widgets are never mounted.
 */

export const CATO_DOCS_URL = "https://docs.ogcato.com/";

/**
 * The game is served inside the main site (same origin, under /updown), so the
 * wordmark and these links are plain full-page navigations back to it.
 * VITE_MAIN_SITE_URL points them elsewhere when the game runs on its own.
 */
const SITE_LINKS = [
  { name: "Staking", href: "/staking" },
  { name: "Swap", href: "/swap" },
  { name: "Wrapped", href: "/wrapped" },
  // The game is the VIP area, so this stays highlighted on every game screen.
  // Play and Portfolio switch inside the page (balance bar), not in the header.
  { name: "VIP", href: "/play", active: true },
];
export function siteUrl(path: string) {
  return (getRuntimeConfig("VITE_MAIN_SITE_URL") || "").replace(/\/$/, "") + path;
}

const socialLinks = () => [
  {
    label: "X (Twitter)",
    href: getRuntimeConfig("VITE_TWITTER_URL") || "https://x.com/SolanaCATO",
    icon: "𝕏",
  },
  {
    label: "Telegram",
    href: getRuntimeConfig("VITE_TELEGRAM_URL") || "https://t.me/SolanaCAT",
    icon: "✈",
  },
  {
    label: "Discord",
    href:
      getRuntimeConfig("VITE_DISCORD_URL") || "https://discord.gg/solanascato",
    icon: "💬",
  },
  { label: "GitHub", href: "https://github.com/SOL-CAT", icon: "⌥" },
];

export function isNavItemActive(href: string, pathname: string) {
  if (href === "/") return !pathname.startsWith("/portfolio");
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function CatoHeader() {
  const headerRef = useRef<HTMLElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  useNavOverflow(headerRef, navRef);
  useFocusableChainTrigger(actionsRef);
  return (
    <header className="cato-header" ref={headerRef}>
      <a href={siteUrl("/")} className="cato-header-brand" aria-label={`${CATO_SITE_WORDMARK} home`}>
        <CatoSiteBrand />
      </a>
      <nav className="cato-header-nav" aria-label="Main" ref={navRef}>
        {SITE_LINKS.map((item) => (
          <a
            key={item.href}
            href={siteUrl(item.href)}
            className="cato-header-link"
            data-active={item.active || undefined}
            aria-current={item.active ? "page" : undefined}
          >
            {item.name}
          </a>
        ))}
        <a
          href={CATO_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="cato-header-link"
        >
          Docs ↗
        </a>
        <SocialsMenu />
      </nav>
      <div className="cato-header-actions" ref={actionsRef}>
        <ChainMenuWidget />
        <WalletControl />
      </div>
    </header>
  );
}

/**
 * On narrow screens the nav row scrolls horizontally. Flag on the header
 * which edges still hide links so CSS can fade them (overflow affordance).
 */
function useNavOverflow(
  headerRef: RefObject<HTMLElement>,
  navRef: RefObject<HTMLElement>,
) {
  useEffect(() => {
    const header = headerRef.current;
    const nav = navRef.current;
    if (!header || !nav) return;
    const update = () => {
      const max = nav.scrollWidth - nav.clientWidth;
      header.toggleAttribute("data-nav-overflow-start", max > 1 && nav.scrollLeft > 1);
      header.toggleAttribute("data-nav-overflow-end", max > 1 && nav.scrollLeft < max - 1);
    };
    update();
    nav.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    const observer =
      typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(update);
    observer?.observe(nav);
    return () => {
      nav.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
      observer?.disconnect();
    };
  }, [headerRef, navRef]);
}

/**
 * The SDK's desktop chain picker is a Radix menu trigger rendered as a <div>,
 * so it is skipped by Tab. Radix already toggles it on Enter / Space (and
 * opens on ArrowDown); it only needs to be reachable and named. The SDK can
 * swap the element (chain change, desktop/mobile switch), so re-apply on
 * every child change of the actions container.
 */
export function useFocusableChainTrigger(actionsRef: RefObject<HTMLElement>) {
  useEffect(() => {
    const actions = actionsRef.current;
    if (!actions) return;
    const apply = () => {
      const trigger = actions.querySelector<HTMLElement>(
        ':scope > div[aria-haspopup="menu"]:not([tabindex])',
      );
      if (!trigger) return;
      trigger.tabIndex = 0;
      trigger.setAttribute("role", "button");
      if (!trigger.hasAttribute("aria-label")) {
        trigger.setAttribute("aria-label", "Switch network");
      }
    };
    apply();
    const observer = new MutationObserver((records) => {
      apply();
      for (const record of records) {
        const trigger = record.target as HTMLElement;
        // On close (Escape / select) the SDK leaves focus in the exiting menu,
        // which then drops it to <body>; hand it back to the trigger so
        // keyboard users keep their place.
        if (
          record.type === "attributes" &&
          record.oldValue === "true" &&
          trigger.parentElement === actions &&
          trigger.getAttribute("aria-expanded") === "false"
        ) {
          const active = document.activeElement;
          if (!active || active === document.body || active.closest('[role="menu"]')) {
            trigger.focus();
          }
        }
      }
    });
    observer.observe(actions, {
      childList: true,
      subtree: true,
      attributeFilter: ["aria-expanded"],
      attributeOldValue: true,
    });
    return () => observer.disconnect();
  }, [actionsRef]);
}

/** "7xKqAbCd…Xy3fPq" -> "7xKq…3fPq". */
export function shortAddress(address: string) {
  return address.length > 10 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/** Open/close state for a header dropdown anchored under its trigger. */
function useAnchoredMenu() {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; right: number }>();
  const buttonRef = useRef<HTMLButtonElement>(null);

  const toggle = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    // Fixed positioning keeps the menu visible when the mobile nav row scrolls.
    if (rect) {
      setPosition({
        top: rect.bottom + 8,
        right: Math.max(8, window.innerWidth - rect.right),
      });
    }
    setOpen((value) => !value);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return { open, setOpen, position, buttonRef, toggle };
}

/**
 * Mirrors the SDK AccountMenu's branching: the connected menu shows only when
 * not validating / connect-disabled / on a wrong network, and trading is enabled.
 */
function WalletControl() {
  const { account, state } = useAccount();
  const { disconnect } = useWalletConnector();
  const { wrongNetwork, disabledConnect } = useAppContext();
  const connected =
    !state.validating &&
    !disabledConnect &&
    !wrongNetwork &&
    !!state.address &&
    (state.status === AccountStatusEnum.EnableTrading ||
      state.status === AccountStatusEnum.EnableTradingWithoutConnected);
  if (!connected) return <AccountMenuWidget />;
  // Same steps as the SDK's useAccountMenu().onDisconnect.
  const onDisconnect = async () => {
    localStorage.removeItem("orderly_link_device");
    await disconnect({ label: state.connectWallet?.name });
    await account.disconnect();
  };
  return <WalletMenu address={state.address!} onDisconnect={onDisconnect} />;
}

function WalletMenu({
  address,
  onDisconnect,
}: {
  address: string;
  onDisconnect: () => Promise<void>;
}) {
  const { open, setOpen, position, buttonRef, toggle } = useAnchoredMenu();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard?.writeText(address).then(() => setCopied(true));
  };

  return (
    <div className="cato-wallet">
      <button
        ref={buttonRef}
        type="button"
        className="cato-wallet-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Wallet ${address}`}
        title={address}
        data-testid="cato-wallet-button"
        onClick={toggle}
      >
        <Wallet size={16} aria-hidden className="cato-wallet-icon" />
        <span className="cato-wallet-address">{shortAddress(address)}</span>
        <ChevronDown size={14} aria-hidden className="cato-wallet-chevron" />
      </button>
      {open && (
        <>
          <div className="cato-header-backdrop" onClick={() => setOpen(false)} />
          <div className="cato-header-menu cato-wallet-menu" role="menu" style={position}>
            <div className="cato-wallet-menu-address" title={address}>
              <Wallet size={16} aria-hidden />
              <span>{shortAddress(address)}</span>
            </div>
            <button type="button" role="menuitem" onClick={copy}>
              <span className="cato-header-menu-icon">
                {copied ? <Check size={15} /> : <Copy size={15} />}
              </span>
              {copied ? "Copied" : "Copy address"}
            </button>
            <button
              type="button"
              role="menuitem"
              className="cato-wallet-disconnect"
              data-testid="cato-wallet-disconnect"
              onClick={() => {
                setOpen(false);
                void onDisconnect();
              }}
            >
              <span className="cato-header-menu-icon">
                <LogOut size={15} />
              </span>
              Disconnect
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function SocialsMenu() {
  const { open, setOpen, position, buttonRef, toggle } = useAnchoredMenu();

  return (
    <div className="cato-header-socials">
      <button
        ref={buttonRef}
        type="button"
        className="cato-header-link cato-header-socials-button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        Socials {open ? "▴" : "▾"}
      </button>
      {open && (
        <>
          <div
            className="cato-header-backdrop"
            onClick={() => setOpen(false)}
          />
          <div className="cato-header-menu" role="menu" style={position}>
            {socialLinks().map((link) => (
              <a
                key={link.label}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                role="menuitem"
                onClick={() => setOpen(false)}
              >
                <span className="cato-header-menu-icon">{link.icon}</span>
                {link.label}
                <span className="cato-header-menu-arrow">↗</span>
              </a>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
