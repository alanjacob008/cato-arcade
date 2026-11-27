import { writeFileSync } from "node:fs";
import { loadEnv } from "vite";
import { CATO_DEFAULTS } from "../app/utils/cato-defaults";

const config = {
  ...CATO_DEFAULTS,
  ...loadEnv(process.env.NODE_ENV || "production", process.cwd(), "VITE_"),
};
const base = config.VITE_BASE_URL || "/";
const manifest = {
  name: config.VITE_APP_NAME,
  short_name: config.VITE_APP_NAME,
  description: config.VITE_APP_DESCRIPTION,
  start_url: base,
  scope: base,
  display: "standalone",
  background_color: "#121212",
  theme_color: "#FEA911",
  icons: [
    {
      src: `${base.replace(/\/$/, "")}/cato-icon.png`,
      sizes: "64x64",
      type: "image/png",
      purpose: "any",
    },
  ],
};
writeFileSync(
  new URL("../public/manifest.json", import.meta.url),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log("Generated Up Down manifest.");
