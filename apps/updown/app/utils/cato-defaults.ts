import { catoThemes } from "./cato-theme";

/** Public configuration only. A fresh checkout runs on testnet without secrets. */
export const CATO_DEFAULTS: Record<string, string> = {
  VITE_ORDERLY_BROKER_ID: "demo",
  VITE_ORDERLY_BROKER_NAME: "Up Down",
  VITE_APP_NAME: "Up Down",
  VITE_APP_DESCRIPTION:
    "The Cato trading terminal. Perpetuals powered by Orderly.",
  VITE_DEPLOYMENT_ENV: "testnet",
  VITE_DISABLE_MAINNET: "true",
  VITE_ENABLED_MENUS: "Trading,Portfolio",
  VITE_CUSTOM_MENUS: "",
  VITE_TELEGRAM_URL: "https://t.me/SolanaCAT",
  VITE_DISCORD_URL: "https://discord.gg/solanascato",
  VITE_TWITTER_URL: "https://x.com/SolanaCATO",
  VITE_AVAILABLE_LANGUAGES: "en",
  VITE_SEO_SITE_NAME: "Up Down",
  VITE_SEO_SITE_URL: "http://127.0.0.1:5185",
  VITE_SEO_SITE_DESCRIPTION:
    "The Cato trading terminal. Perpetuals powered by Orderly.",
  VITE_SEO_THEME_COLOR: "#121212",
  VITE_ORDERLY_THEME_CONFIG: JSON.stringify(catoThemes),
};
