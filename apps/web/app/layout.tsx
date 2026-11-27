import type { ReactNode } from "react";
import type { Metadata } from "next";
import localFont from "next/font/local";
import SiteAnalytics from "../components/SiteAnalytics";
import { Header } from "../components/Header";
import { ArcadeEntryCurtain } from "../components/arcadeEntry/ArcadeEntryCurtain";
import { WalletContextProvider } from "../components/WalletProviderContext";
import "./globals.css";

// Self-hosted so Vercel does not depend on Google Fonts at build time.
// next/font/google was shipping Google's 404 HTML as .woff2 on prod.
// Rubik: clean, slightly rounded body and UI face.
const brandFont = localFont({
  src: "../fonts/Rubik.woff2",
  weight: "300 900",
  display: "swap",
  variable: "--font-brand",
});

// Bricolage Grotesque: characterful display face for headings and hero numbers.
const displayFont = localFont({
  src: "../fonts/BricolageGrotesque.woff2",
  weight: "200 800",
  display: "swap",
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: { default: "$CATO", template: "%s · $CATO" },
  description: "$CATO, the OG cat on Solana. Stake for daily rewards, swap in, and unwrap your year on Solana.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${brandFont.variable} ${displayFont.variable} ${brandFont.className}`}>
      <body
        style={{
          margin: 0,
          background: "#121212",
          color: "#f5f5f5",
          fontFamily:
            "var(--font-brand), system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
        }}
      >
        <WalletContextProvider>
          <Header />
          {children}
          <SiteAnalytics />
          {/* Survives client navigation: carries the home page's "Enter the arcade" into the arcade loading screen. */}
          <ArcadeEntryCurtain />
        </WalletContextProvider>
        {/* The Jupiter swap plugin is loaded only where the widget renders (components/JupiterSwap.tsx). */}
      </body>
    </html>
  );
}
