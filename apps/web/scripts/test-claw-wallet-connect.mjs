import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";

// The site wallet picker's connect flow, driven with a fake picker/adapter and a fake clock.
const source = ts.transpileModule(await readFile(new URL("../components/claw/playerWallet.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const compiled = { exports: {} };
vm.runInNewContext(source, { exports: compiled.exports, module: compiled });
const { waitForWalletConnection } = compiled.exports;

function harness(script) {
  let clock = 0, polls = 0;
  const log = [], state = { address: null, pickerOpen: false, connecting: false, selected: false, ...script.initial };
  const deps = {
    read: () => ({ ...state }),
    openPicker: () => { log.push("open"); state.pickerOpen = true; },
    closePicker: () => { log.push("close"); state.pickerOpen = false; },
    connectSelected: async () => { log.push("connect"); script.onConnect?.(state); },
    sleep: async ms => { clock += ms; polls++; script.onPoll?.(state, polls, clock); },
    now: () => clock,
  };
  return { run: () => waitForWalletConnection(deps), log, clock: () => clock, open: () => state.pickerOpen };
}

// Already connected: no picker.
let h = harness({ initial: { address: "WalletA" } });
assert.equal(await h.run(), "WalletA"); assert.deepEqual(h.log, []);

// Player picks a wallet in the picker: resolves to it and the picker is closed.
h = harness({ onPoll: (s, n) => { if (n === 2) { s.pickerOpen = false; s.connecting = true; } if (n === 4) { s.connecting = false; s.address = "WalletB"; } } });
assert.equal(await h.run(), "WalletB"); assert.equal(h.log[0], "open"); assert.equal(h.open(), false, "picker not left open");
// Auto-connect finishes while the picker is still open: the picker is closed.
h = harness({ onPoll: (s, n) => { if (n === 2) s.address = "WalletE"; } });
assert.equal(await h.run(), "WalletE"); assert.deepEqual(h.log, ["open", "close"]);

// Picker dismissed before the first poll: gives up within the grace period, not the full timeout.
h = harness({ onPoll: s => { s.pickerOpen = false; } });
await assert.rejects(h.run(), /Choose a wallet to play\./); assert(h.clock() <= 2500, `gave up after ${h.clock()} ms`);

// A wallet is already selected but not connected (re-selecting it in the picker would do nothing): connect it directly.
h = harness({ initial: { selected: true }, onConnect: s => { s.address = "WalletC"; } });
assert.equal(await h.run(), "WalletC"); assert.deepEqual(h.log, ["connect"]);

// Selected wallet refuses to connect: fall back to the picker.
h = harness({ initial: { selected: true }, onConnect: () => { throw Error("User rejected the request."); }, onPoll: (s, n) => { if (n === 2) s.address = "WalletD"; } });
assert.equal(await h.run(), "WalletD"); assert.deepEqual(h.log, ["connect", "open", "close"]);

// Nobody chooses: times out and closes the picker it opened.
h = harness({});
await assert.rejects(h.run(), /Wallet connection timed out/); assert.deepEqual(h.log, ["open", "close"]);
console.log("PASS: wallet picker connect flow resolves to the chosen account, handles early dismissal, selected-but-idle wallets and timeouts, and closes the picker.");

// Account switch or disconnect after sign-in: the page drops the old sign-in so the player can connect again without reloading.
const { signedInWalletLost } = compiled.exports;
assert.equal(signedInWalletLost("WalletA", "WalletA"), false);
assert.equal(signedInWalletLost("WalletA", "WalletB"), true, "switched account");
assert.equal(signedInWalletLost("WalletA", null), true, "disconnected");
assert.equal(signedInWalletLost("", "WalletB"), false, "not signed in yet: nothing to drop");
assert.equal(signedInWalletLost("", null), false);
console.log("PASS: a switched or disconnected wallet ends the old sign-in.");
