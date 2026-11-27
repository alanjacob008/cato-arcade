import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/*.test.ts", "apps/**/*.test.ts", "apps/**/*.test.tsx"],
    // The game app has its own Vitest version, jsdom environment and dependency tree.
    exclude: [...configDefaults.exclude, "apps/updown/**"],
    environment: "node",
    globals: false,
  },
});
