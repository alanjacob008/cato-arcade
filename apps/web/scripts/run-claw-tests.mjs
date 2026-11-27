import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const tests = [
  "test-claw-analytics.mjs",
  "test-claw-loading.mjs",
  "test-claw-loading-exit.mjs",
  "test-claw-background.mjs",
  "test-claw-batching.mjs",
  "test-claw-club.mjs",
  "test-claw-feedback.mjs",
  "test-claw-audio.mjs",
  "test-claw-music.mjs",
  "test-claw-room.mjs",
  "test-claw-wallet-entrance.mjs",
  "test-claw-wallet-camera.mjs",
  "test-claw-preloaded-inventory.mjs",
  "test-claw-connection-polling.mjs",
  "test-claw-framing.mjs",
  "test-claw-performance.mjs",
  "test-claw-rewards.mjs",
  "test-claw-scene.mjs",
  "test-claw-stats.mjs",
  "test-claw-tokens.mjs",
  "test-claw-transport.mjs",
  "test-prize-grip.mjs"
];
for (const file of tests) execFileSync(process.execPath, [fileURLToPath(new URL(file, import.meta.url))], { stdio: "inherit" });
