import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";
import { cjsInterop } from "vite-plugin-cjs-interop";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import tsconfigPaths from "vite-tsconfig-paths";
import { validateGameNetworkEnv } from "./app/utils/deployment-network.mjs";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  // Fail the build (and dev server) on a network setting the round service would
  // read differently; see app/utils/deployment-network.mjs.
  validateGameNetworkEnv(env);
  return {
    server: { host: "127.0.0.1", port: 5185, strictPort: true, open: false,
      // The main site (apps/web, :3000) proxies /updown/* here. Proxies do not carry
      // the HMR websocket, so the client dials this server directly for it.
      hmr: { host: "127.0.0.1", port: 5185, clientPort: 5185 },
      fs: { deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.runtime/**"] },
      proxy: { "/game-api": { target: "http://127.0.0.1:5186", changeOrigin: true } } },
    preview: { host: "127.0.0.1", port: 5185, strictPort: true },
    base: env.VITE_BASE_URL || "/",
    plugins: [
      react(),
      tsconfigPaths(),
      cjsInterop({ dependencies: ["bs58", "@coral-xyz/anchor", "lodash"] }),
      nodePolyfills({ include: ["buffer", "crypto", "stream"] }),
    ],
    build: { outDir: "build/client" },
    optimizeDeps: { include: ["react", "react-dom", "react-router-dom"] },
  };
});
