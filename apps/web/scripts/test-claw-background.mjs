import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { clawModule } from "./claw-test-loader.mjs";
const { createMachineLoop } = await import(await clawModule("machineLoop"));
function fakeClock(fps = 60) {
  let now = 0, hidden = false, id = 0;
  const tasks = new Map();
  const enqueue = (fn, delay, kind) => { const key = ++id; tasks.set(key, { fn, at: now + delay, kind }); return key; };
  const clock = { now: () => now, hidden: () => hidden, requestFrame: fn => enqueue(fn, 1000 / fps, "frame"), cancelFrame: key => tasks.delete(key),
    timeout: (fn, delay) => enqueue(fn, delay, "timer"), clearTimeout: key => tasks.delete(key) };
  return { clock, tasks, hide(value) { hidden = value; },
    async advance(ms, throttled = false) {
      const until = now + ms; if (throttled) now = until;
      for (let count = 0; count < 10000; count++) {
        const next = [...tasks].sort((a,b) => a[1].at - b[1].at)[0]; if (!next || next[1].at > until) break;
        const [key, task] = next; tasks.delete(key); now = Math.max(now, task.at); task.fn(now); await Promise.resolve();
        assert(count < 9999, "Catch-up must have a bounded amount of work");
      }
      now = until;
    } };
}
for (const scenario of ["visible", "hidden", "switch-tabs", "throttled"]) {
  const fake = fakeClock(), states = [];
  let mode = "moving", elapsed = 0, draws = 0, settled = 0, paintedHidden = 0, waiting = null;
  if (scenario === "hidden" || scenario === "throttled") fake.hide(true);
  const loop = createMachineLoop((now, dt, paint) => {
    if (fake.clock.hidden() && paint) paintedHidden++;
    assert(dt >= 0 && dt <= .05000001, "Even delayed timers replay safe simulation steps");
    if (mode !== "moving") return;
    elapsed += dt * 1000;
    if (!draws && elapsed >= 1550) {
      states.push("gripped"); draws++; mode = "waiting";
      waiting = Promise.resolve().then(() => { mode = "moving"; });
    } else if (elapsed >= 2900 && !states.includes("delivered")) states.push("delivered");
    else if (elapsed >= 4400 && !states.includes("landed")) states.push("landed");
    else if (elapsed >= 5150) { assert(states.includes("landed")); settled++; mode = "idle"; }
  }, () => mode !== "idle", fake.clock);
  loop.start();
  if (scenario === "switch-tabs") { await fake.advance(900); fake.hide(true); loop.visibility(); }
  await fake.advance(scenario === "throttled" ? 60000 : 6500, scenario === "throttled");
  await waiting;
  assert.equal(settled,1, scenario + " completes its in-flight round"); assert.equal(draws,1); assert.equal(paintedHidden,0);
  assert.deepEqual(states,["gripped","delivered","landed"]);
  fake.hide(false); loop.visibility(); await fake.advance(1000); assert.equal(settled,1,"Returning to a tab never settles or draws twice");
  loop.dispose(); assert.equal(fake.tasks.size,0,"Dispose cancels timers and RAFs");
}
for (const fps of [30,60,90,120,144,240]) {
  const fake = fakeClock(fps); let simulated = 0, paints = 0;
  const loop = createMachineLoop((_now,dt,render) => { simulated += dt; paints += Number(render); },()=>true,fake.clock);
  loop.start(); await fake.advance(3000); loop.dispose();
  assert(Math.abs(simulated - 3) < .05,"High refresh frame gating cannot slow simulation time");
  assert(paints <= 182 && paints >= Math.min(fps,60)*3-3,"Preserve the 60Hz render budget and lower device cadence");
}
// Render the actual tooltip component to check anchor/description markup.
const source = await readFile(new URL("../components/claw/PlayerArcade.tsx",import.meta.url),"utf8");
const ast = ts.createSourceFile("player.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const label = ast.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==="WinningsLabel");assert(label);
const js = ts.transpileModule('const WINNINGS_NOTE="These winnings are exclusive of price paid for the tokens"; const styles={winningsHint:"anchor",winningsLabel:"label",winningsTooltip:"tooltip"};\n'+label.getText(ast)+'\nexport {WinningsLabel};',
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText.replace('"react/jsx-runtime"',JSON.stringify(import.meta.resolve("react/jsx-runtime")));
const { WinningsLabel } = await import("data:text/javascript;base64,"+Buffer.from(js).toString("base64"));
for (const [id,text] of [["session-winnings-note","SESSION WINNINGS"],["cumulative-winnings-note","Cumulative Winnings"]]) {
  const html = renderToStaticMarkup(createElement(WinningsLabel,{id},text));
  assert(html.includes('aria-describedby="'+id+'"')); assert(html.includes('id="'+id+'" role="tooltip"')); assert(!html.includes('title='));
}
console.log("PASS: visible/hidden/switched/throttled rounds complete once, ordered grip/delivery/landing, no hidden GPU paint, disposal, 30–240Hz cadence and UI tooltip descriptions.");
