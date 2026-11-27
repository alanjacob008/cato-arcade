import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Render the real controls. Only Next asset/dynamic loading is stubbed; React,
// token rules and the components' enabled/disabled decisions run unchanged.
const nativeRequire = createRequire(import.meta.url), modules = new Map();
let renderedElements = [], dynamicProps = [];
function load(file) {
  if (modules.has(file)) return modules.get(file);
  const compiledModule = { exports: {} }; modules.set(file, compiledModule.exports);
  const source = ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true,
  } }).outputText;
  const require = name => {
    if (name.endsWith(".css")) return { __esModule: true, default: new Proxy({}, { get: (_object, key) => String(key) }) };
    if (name === "next/dynamic") return { __esModule: true, default: () => props => { dynamicProps.push(props); return null; } };
    if (name === "react/jsx-runtime") {
      const runtime = nativeRequire(name);
      return { ...runtime, ...Object.fromEntries(["jsx", "jsxs"].map(key => [key, (type, props, ...rest) => {
        renderedElements.push({ type, props }); return runtime[key](type, props, ...rest);
      }])) };
    }
    if (name === "next/image") return { __esModule: true, default: ({ src, alt, width, height }) => React.createElement("img", { src, alt, width, height }) };
    if (!name.startsWith(".")) return nativeRequire(name);
    const path = resolve(dirname(file), name), candidate = [path + ".ts", path + ".tsx"].find(existsSync);
    if (!candidate) throw Error(`Missing test dependency ${name}`);
    return load(candidate);
  };
  vm.runInNewContext(source, { module: compiledModule, exports: compiledModule.exports, require, console, setTimeout, clearTimeout, URL, TextEncoder });
  return compiledModule.exports;
}
const base = fileURLToPath(new URL("../components/claw/", import.meta.url));
const Player = load(resolve(base, "PlayerArcade.tsx")).default, Shop = load(resolve(base, "TokenShop.tsx")).default;
const daily = load(resolve(base, "daily.ts")).dailyArrangement("preview-test", Date.UTC(2026, 9, 28));
const noop = () => {};
const props = { host: { current: null }, daily, now: Date.UTC(2026, 9, 28), tier: 0, ready: true, busy: false, renderError: false,
  topView: false, empty: false, persistent: true, phase: "ready", result: null, history: [], sessionWinningsCents: 200, totalWinningsCents: 600,
  availableWinningsCents: 600, sessionWithdrawableCents: 200, onWithdraw: noop, tokenBalances: [10, 10, 10], theme: "violet",
  progress: { plays: 3, catches: 2, rareCatches: 0 }, receipts: [], soundMuted: false, onSound: noop, onBuyTokens: noop, onTier: noop,
  onDragAim: noop, onView: noop, onDrop: noop };
const session = { wallet: "Samyz-test-wallet", connecting: false, onConnect: noop, pending: false, onResume: noop,
  active: true, remaining: 3, checking: false, error: "", onRefresh: noop };
const render = changes => { renderedElements = []; dynamicProps = []; return renderToStaticMarkup(React.createElement(Player, { ...props, ...changes })); };
const button = (html, label) => [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)].find(match => match[2].replace(/<[^>]*>/g, "").replaceAll("&amp;", "&") === label);
const preview = render({ testSession: session });
assert(button(preview,"Top view"),"Front view offers the top-down aiming camera");
assert(button(render({testSession:session,topView:true}),"Front view"),"Top view returns to the front camera");
assert(preview.includes("3 sponsored plays left")); assert(preview.includes("Payments and withdrawals are disabled"));
assert(preview.includes("GET TEST TOKENS")); assert(!preview.includes("BUY TOKENS"));
assert(!button(preview, "INSERT & DROP")[1].includes("disabled")); assert(button(preview, "WITHDRAW")[1].includes("disabled"));
const entering=render({testSession:{...session,wallet:""},ready:false,entering:true,loading:{percent:75,label:"Building your machine"}});
assert(entering.includes('class="entryLoading"')&&entering.includes("Arcade loading...")&&entering.includes("cato-mascot-transparent.png"));
assert(entering.includes("Building your machine"));assert(button(entering,"CONNECT WALLET")[1].includes("disabled"));assert(button(entering,"Top view")[1].includes("disabled"));
assert(!dynamicProps.some(props=>props.ready&&!props.requested),"Tutorial cannot obscure the loading-to-lights reveal");
const connectingWarm=render({testSession:{...session,connecting:true},entering:false});
assert(!connectingWarm.includes('class="entryLoading"')&&!connectingWarm.includes("Arcade loading..."),"Wallet connection leaves the preloaded machine visible");
assert(connectingWarm.includes('aria-label="Aim the claw"'));assert(button(connectingWarm,"INSERT & DROP")[1].includes("disabled"),"Authentication cannot start a play before sign-in finishes");
const disconnected = render({ testSession: { ...session, wallet: "" } });
assert(!button(disconnected,"Top view")[1].includes("disabled"),"Camera inspection does not require wallet login");
assert(!button(disconnected, "CONNECT WALLET")[1].includes("disabled"));
assert(dynamicProps.some(props => props.testMode && props.ready && !props.requested), "First-time onboarding mounts before wallet login");
assert(disconnected.includes("sign the login message"));
// Backend unreachable: the notice says so instead of "Checking…", and connecting is disabled until it is back.
const down = render({ testSession: { ...session, wallet: "", active: false, remaining: null, unavailable: true } });
assert(down.includes("Connection interrupted")); assert(!down.includes("Checking sponsored plays"));
assert(button(down, "CONNECT WALLET")[1].includes("disabled"));
const downSignedIn = render({ testSession: { ...session, active: false, remaining: null, unavailable: true } });
assert(!button(downSignedIn, "RETRY CONNECTION")[1].includes("disabled"), "Signed-in players can retry a failed status check");
assert(!downSignedIn.includes("Ask the test host to renew sponsored plays"));assert(!button(downSignedIn,"INSERT & DROP"),"Connection errors never leave play enabled or masquerade as exhausted sponsorship");
assert(button(render({testSession:{...session,unavailable:true,checking:true}}),"RECONNECTING…")[1].includes("disabled"));
let reconnects=0,drops=0;
render({testSession:{...session,unavailable:true,onRefresh:()=>reconnects++},onDrop:()=>drops++});
const retryControl=renderedElements.find(element=>element.type==="button"&&element.props.children==="RETRY CONNECTION");
retryControl.props.onClick();assert.equal(reconnects,1);assert.equal(drops,0,"Retry connection only refreshes status and never starts a paid/token play");
const exhausted = render({ testSession: { ...session, active: false, remaining: 0 } });
assert(button(exhausted, "SPONSORED PLAYS UNAVAILABLE")[1].includes("disabled"));
const recovery = render({ testSession: { ...session, active: false, remaining: 0, pending: true } });
assert(!button(recovery, "RESUME ATTEMPT")[1].includes("disabled"), "Quota exhaustion cannot lock out recovery");
assert(button(render({ testSession: session, busy: true }), "IN PLAY")[1].includes("disabled"));
assert(!button(render({}), "WITHDRAW")[1].includes("disabled"), "Existing demo withdrawal controls remain unchanged");
const shop = renderToStaticMarkup(React.createElement(Shop, { initialTier: 0, onClose: noop, onBuy: noop, testMode: true }));
assert(shop.includes("Get free test tokens")); assert(shop.includes("No wallet payment")); assert(shop.includes("SILVER TEST TOKENS"));
const funded=render({testSession:{...session,paymentsEnabled:true,onWithdraw:noop}});
assert(funded.includes("DEVNET USDC"));assert(funded.includes("BUY TOKENS"));assert(!funded.includes("GET TEST TOKENS"));
assert(!button(funded,"WITHDRAW")[1].includes("disabled"),"Funded-devnet winnings can enter the real test-USDC withdrawal flow");
const pendingCashout=render({availableWinningsCents:0,testSession:{...session,paymentsEnabled:true,pendingWithdrawal:true,onWithdraw:noop}});
assert(!button(pendingCashout,"CHECK WITHDRAWAL")[1].includes("disabled"),"Reserved payouts remain recoverable at zero available balance");
const paidShop=renderToStaticMarkup(React.createElement(Shop,{initialTier:0,onClose:noop,onBuy:noop,fundedDevnet:true}));
assert(paidShop.includes("Buy devnet tokens"));assert(paidShop.includes("BUY 10 SILVER TOKENS"));assert(!paidShop.includes("No wallet payment"));

// Exercise the real canvas event handlers with touch-style pointer events.
const movements = [], captures = [];
render({ testSession: session, onDragAim: (x, y) => movements.push([x, y]) });
const canvas = renderedElements.find(item => item.props["aria-label"] === "Aim the claw").props;
let focused = false;
const target = { setPointerCapture: id => captures.push(id), focus: () => { focused = true; }, getBoundingClientRect: () => ({ width: 400, height: 300 }) };
const finger = (id, x, y, isPrimary = true) => ({ pointerType: "touch", pointerId: id, clientX: x, clientY: y, button: 0, isPrimary, currentTarget: target });
canvas.onPointerMove(finger(1, 80, 90)); assert.equal(movements.length, 0, "Hover never aims");
canvas.onPointerDown(finger(1, 80, 90));
canvas.onPointerMove(finger(1, 120, 60)); assert.deepEqual(movements, [[.1, -.1]]);
assert.deepEqual(captures, [1]); assert(focused, "Aiming focuses the machine without scrolling");
canvas.onPointerDown(finger(2, 0, 0, false)); canvas.onPointerMove(finger(2, 400, 300, false));
assert.equal(movements.length, 1, "A second finger cannot hijack aiming");
canvas.onPointerCancel(finger(1, 120, 60)); canvas.onPointerMove(finger(1, 400, 300));
assert.equal(movements.length, 1, "Cancelled swipes stop aiming");
canvas.onPointerDown(finger(3, 50, 50)); canvas.onLostPointerCapture(finger(3, 50, 50)); canvas.onPointerMove(finger(3, 100, 100));
assert.equal(movements.length, 1, "Lost capture cannot leave a stuck drag");
canvas.onPointerDown(finger(4, 50, 50)); canvas.onPointerUp(finger(4, 50, 50)); canvas.onPointerMove(finger(4, 100, 100));
assert.equal(movements.length, 1);
render({ testSession: session, busy: true, onDragAim: () => assert.fail("Busy claw cannot move") });
const busyCanvas = renderedElements.find(item => item.props["aria-label"] === "Aim the claw").props;
busyCanvas.onPointerDown(finger(5, 20, 20)); busyCanvas.onPointerMove(finger(5, 60, 60));

const Receipts = load(resolve(base, "PlayReceipts.tsx")).default;
const { vrfExplorerLink } = load(resolve(base, "vrfExplorer.ts"));
const requestSignature = "2g17uDPidjxFi3xr8rXyiJK9Aypq2Zyp37JNjWN8cYQMSuViQkqN3CcGDdfv6AXTrksefkhrDf8imqpKcXcTJCwQ";
const callbackSignature = "4ujUpwzE7WdXbnyjUNVbGtFM3n2vBW2mfdQbWAXiyUGstXZNBkwNoJKuQr7CRFVSigVdLfe5o5HkM5jZD6L8b5om";
const receipt = { id: "real-draw", tier: 0, entryCents: 200, prizeCents: 150, netCents: -50,
  vrf: { targetId: "box", source: "magicblock-vrf", requestSignature, callbackSignature } };
const receiptsMarkup = (receipts, extra = {}) => renderToStaticMarkup(React.createElement(Receipts, { receipts, devnet: true, execution: "er", freeTest: true, ...extra }));
const verified = receiptsMarkup([receipt]);
assert(verified.includes("Verified VRF")); assert(verified.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").includes("+1.50 test USDC")); assert(!verified.includes("local demo"));
assert(verified.includes("Token value") && verified.includes("2 test USDC"), "Free-token tickets show nominal token value without calling it a payment");
assert.equal((verified.match(/target="_blank" rel="noopener noreferrer"/g) || []).length, 2);
for (const signature of [requestSignature, callbackSignature]) {
  const url = new URL(vrfExplorerLink(signature, "er"));
  assert.equal(url.origin, "https://explorer.solana.com"); assert.equal(url.pathname, `/tx/${signature}`);
  assert.equal(url.searchParams.get("cluster"), "custom"); assert.equal(url.searchParams.get("customUrl"), "https://devnet-as.magicblock.app");
}
assert.equal(new URL(vrfExplorerLink(requestSignature, "base")).searchParams.get("cluster"), "devnet");
for (const signature of [null, "", "javascript:alert(1)", requestSignature + "?key=secret", "0".repeat(88)]) assert.equal(vrfExplorerLink(signature, "er"), null);
assert.equal(vrfExplorerLink(requestSignature), null, "Unknown network must not default to the wrong explorer");
const empty = receiptsMarkup([{ ...receipt, prizeCents: 0, vrf: { ...receipt.vrf, targetId: null, requestSignature: null, callbackSignature: null } }]);
assert(empty.includes("No target · no VRF request")); assert(!empty.includes("Verified VRF")); assert(!empty.includes("<a "));
const partial = receiptsMarkup([{ ...receipt, vrf: { ...receipt.vrf, callbackSignature: null } }]);
assert(!partial.includes("Verified VRF")); assert(partial.includes("VRF receipt unavailable"));
assert(!receiptsMarkup([receipt], { execution: undefined }).includes("Verified VRF"));
assert(receiptsMarkup([], {}).includes("No completed plays yet"));
assert(receiptsMarkup([receipt], { devnet: false }).includes("These are local demo receipts"));
const demoTicket = receiptsMarkup([receipt], { devnet: false, freeTest: false });
assert(demoTicket.includes("Entry") && demoTicket.includes("Net") && demoTicket.includes("−0.50 USDC"), "Ticket layout preserves the local receipt's entry and net amounts");
assert.equal((receiptsMarkup(Array.from({length: 60}, (_, i) => ({ ...receipt, id: `draw-${i}` }))).match(/Verified VRF/g) || []).length, 50);

const Tutorial = load(resolve(base, "ArcadeTutorial.tsx")).default;
let closed = 0;
renderedElements = [];
const tutorial = renderToStaticMarkup(React.createElement(Tutorial, { ready: true, requested: false, testMode: true, onClose: () => closed++ }));
assert(tutorial.indexOf("Connect Wallet") < tutorial.indexOf("Get Test Tokens"));
assert(tutorial.includes("sign the login message")); assert(tutorial.includes("swipe with one finger"));
assert(tutorial.includes("VRF request and callback links")); assert(tutorial.includes("Payments and withdrawals are disabled"));
const modal = renderedElements.find(item => item.type === "dialog").props;
assert.equal(modal.onClick, undefined, "Text selection/backdrop clicks cannot dismiss the tutorial");
let cancelled = 0;
modal.onKeyDown({ key: "Tab", preventDefault: () => cancelled++, stopPropagation: noop });
assert.equal(cancelled, 0); assert.equal(closed, 0, "Other keys leave the tutorial open");
modal.onKeyDown({ key: "Escape", preventDefault: () => cancelled++, stopPropagation: noop });
assert.equal(cancelled, 1); assert.equal(closed, 1, "Escape dismisses the tutorial like the X");
modal.onCancel({ preventDefault: () => cancelled++ });
assert.equal(cancelled, 2); assert.equal(closed, 2, "A native close request dismisses it through the same path");
renderedElements.find(item => item.type === "button" && item.props["aria-label"] === "Close tutorial").props.onClick();
assert.equal(closed, 3, "Explicit X remains available");
const { hasSeenTutorial, rememberTutorial } = load(resolve(base, "tutorial.ts"));
const seen = new Map(), storage = { getItem: key => seen.get(key), setItem: (key, value) => seen.set(key, value) };
rememberTutorial(storage); assert(hasSeenTutorial(storage)); assert(!hasSeenTutorial(storage, "devnet"), "Seeing the old demo tutorial does not hide connect-first onboarding");
rememberTutorial(storage, "devnet"); assert(hasSeenTutorial(storage, "devnet"));
const {OutcomeToast,ResultEffects}=load(resolve(base,"ArcadeOutcome.tsx"));
const outcomeMarkup=renderToStaticMarkup(React.createElement(OutcomeToast,{success:true,cents:150}));
assert(outcomeMarkup.includes("You won"));assert(outcomeMarkup.includes("1.50"),"The result starts at its full amount, without a count-up");
for(const cents of [200,300,2500])assert(renderToStaticMarkup(React.createElement(OutcomeToast,{success:true,cents})).includes(`+${(cents/100).toFixed(2)}`),"Whole-dollar wins retain two decimals");
const particles=(success,cents)=>renderToStaticMarkup(React.createElement(ResultEffects,{success,cents}));
assert.equal((particles(true,200).match(/class="pixelPrize"/g)||[]).length,10);
assert.equal((particles(true,2000).match(/class="pixelPrize"/g)||[]).length,18);
assert(!particles(false,0).includes('class="pixelPrize"'),"Misses do not get winning confetti");
assert(!particles(true,200).includes("resultRing"),"The unwanted green square/ring has been removed");
assert(particles(true,200).includes('aria-hidden="true"'),"Decorative effects do not interrupt announcements");
const pendingOutcome=render({testSession:session,busy:true,result:{pullId:"locked",success:true,cents:200,targetId:"box",probability:.5,roll:.1,source:"magicblock-vrf"}});
assert(!pendingOutcome.includes('class="resultEffects"'),"An unresolved/in-motion play cannot celebrate a future outcome");
let activated=0;render({testSession:session,onActivateAudio:()=>activated++});
renderedElements.find(item=>item.props["aria-label"]==="Aim the claw").props.onPointerDown(finger(20,30,40));
assert.equal(activated,1,"Mouse and touch interaction unlock the audio context before movement");
assert(preview.includes('aria-label="Audio settings: music on, sound effects on"'),"One bottom-right audio trigger replaces the separate header toggle");
assert(preview.includes('aria-label="Audio options"'));assert(preview.includes("Music + SFX"));
assert(!preview.includes('aria-label="Mute sound effects"'));
assert.equal((preview.match(/data-arcade-sound="button"/g)||[]).length,1,"Only the primary Connect/Insert & Drop button gets a click sample");
const connectingPreview=render({testSession:{...session,wallet:""}});assert.equal((connectingPreview.match(/data-arcade-sound="button"/g)||[]).length,1);
const {default:AudioControls}=load(resolve(base,"BackgroundMusic.tsx"));let effectsToggles=0;
renderedElements=[];const controlsMarkup=renderToStaticMarkup(React.createElement(AudioControls,{effectsMuted:true,onToggleEffects:()=>effectsToggles++}));
assert(controlsMarkup.includes('aria-pressed="mixed"'),"Combined control reports independent music/SFX preferences");
const controlButton=label=>renderedElements.find(item=>item.type==="button"&&Array.isArray(item.props.children)&&item.props.children[0]?.props?.children===label);
controlButton("Music").props.onClick();assert.equal(effectsToggles,0,"Music toggle leaves SFX alone");
controlButton("Music + SFX").props.onClick();assert.equal(effectsToggles,1,"Combined toggle can enable the muted channel");
assert(preview.includes('<audio preload="none" hidden="" aria-hidden="true"></audio>'),"Music has no startup source/preload or autoplay");
assert(preview.includes('/claw/cato-mascot-transparent.png'));
// HUD toggles name what a press does, so none of them also carries aria-pressed (a pressed "Turn sound on" contradicts itself).
assert(!/<button[^>]*data-claw-sound-toggle[^>]*aria-pressed/.test(preview) && !/<button[^>]*aria-pressed[^>]*data-claw-sound-toggle/.test(preview), "The sound toggle has no aria-pressed");
assert(!/<button[^>]*data-music-control[^>]*aria-pressed/.test(preview) && !/<button[^>]*aria-pressed[^>]*data-music-control/.test(preview), "The music toggle has no aria-pressed");
assert(!button(preview, "Top view")[1].includes("aria-pressed") && !button(render({ testSession: session, topView: true }), "Front view")[1].includes("aria-pressed"), "The view toggle has no aria-pressed");
assert(render({ testSession: session, soundMuted: true }).includes('aria-label="Audio settings: music on, sound effects off"'),"The combined audio trigger reflects the separate SFX preference");
// The tray shows static renders of the real tokens from its first frame: no second WebGL renderer at runtime.
for (const name of ["silver", "gold", "diamond"]) {
  assert(preview.includes(`src="/claw/tokens/${name}.webp"`), `The tray shows the ${name} token picture`);
  assert(existsSync(new URL(`../public/claw/tokens/${name}.webp`, import.meta.url)), `public/claw/tokens/${name}.webp exists`);
}
for (const file of ["PlayerArcade.tsx", "TokenPreview.tsx", "TokenShop.tsx", "AuthoritativeArcade.tsx", "ClawArcade.tsx"])
  assert(!/(import\(|from )"\.\/tokenThumbnails"/.test(readFileSync(resolve(base, file), "utf8")), `${file} does not render token thumbnails at runtime`);
console.log("PASS: touch aiming/cancellation/multitouch/busy controls, devnet proof links and honest missing/empty receipts, connect-first onboarding and tutorial dismissal by Escape or the X only (never a backdrop click).");
console.log("PASS: actual player controls render free-token disclosures, wallet entry, disabled withdrawals, exhausted-quota blocking, recovery at zero quota, busy protection, and unchanged demo controls.");
