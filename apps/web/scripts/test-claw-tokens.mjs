import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
import * as THREE from "three";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
const compile = async name => ts.transpileModule(await readFile(new URL(`../components/claw/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const url = js => `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
const surface = url((await compile("materialTextures")).replace('"three"', JSON.stringify(import.meta.resolve("three"))));
const config = url(await compile("config")), stats = url(await compile("playerStats"));
const tokens = url((await compile("tokens")).replace('"./config"', JSON.stringify(config)).replace('"./playerStats"', JSON.stringify(stats)));
const { TOKEN_TYPES, availableWinningsCents, sessionWithdrawableCents, withdrawDemoWinnings, withdrawnPrizeCents, MAX_TOKEN_QUANTITY, isTokenQuantity, createTokenWallet, buyDemoTokens: buy, insertDemoToken: insert, ejectDemoToken: eject, settleDemoToken: settle, restoreTokenWallet: restore, serializeTokenWallet: serialize, tokenWalletKey, tokenTier } = await import(tokens);
assert.deepEqual(TOKEN_TYPES.map(type => type.priceCents), [200, 400, 600]);
let wallet = createTokenWallet({ prizeCents: 500, entryCents: 200 });
wallet = buy(wallet, "purchase-1", 0, 10);
assert.deepEqual(wallet.balances, [10, 0, 0]);
assert.deepEqual(wallet.totals, { prizeCents: 500, entryCents: 200 }, "Unspent purchases are not played costs");
assert.equal(buy(wallet, "purchase-1", 0, 10), wallet, "Purchase retries issue credits once");
assert.throws(() => buy(wallet, "purchase-1", 1, 10));
wallet = buy(wallet, "purchase-2", 1, 20);
wallet = buy(wallet, "purchase-3", 2, 10);
assert.deepEqual(wallet.balances, [10, 20, 10], "Each receipt holds one tier only");
wallet = insert(wallet, "play-1", 0);
assert.deepEqual(wallet.balances, [9, 20, 10]);
assert.equal(insert(wallet, "play-1", 0), wallet, "One reservation per attempt");
assert.throws(() => insert(wallet, "other-play", 1), "Cannot change tier while armed");
assert.deepEqual(JSON.parse(serialize(restore(serialize(wallet)))), wallet, "Reload retains inserted token, balances and legacy totals");
wallet = eject(wallet, "play-1");
assert.deepEqual(wallet.balances, [10, 20, 10]);
wallet = settle(insert(wallet, "play-2", 1), "play-2", 2000);
assert.deepEqual(wallet.balances, [10, 19, 10]);
assert.deepEqual(wallet.totals, { prizeCents: 2500, entryCents: 600 });
assert.equal(settle(wallet, "play-2", 2000), wallet, "Duplicate callback does not pay twice");
assert.throws(() => settle(wallet, "play-2", 1000));
assert.throws(() => insert(wallet, "play-2", 1));
assert.throws(() => eject(wallet, "play-2"));
wallet = settle(insert(wallet, "play-3", 2), "play-3", 0);
assert.deepEqual(wallet.totals, { prizeCents: 2500, entryCents: 1200 }, "Miss charges precisely the inserted token's face value");
assert.deepEqual(JSON.parse(serialize(restore(serialize(wallet)))), wallet);
// A reward update must not discard existing credits or past retired-prize wins.
const legacy = JSON.parse(serialize(wallet));
legacy.used["play-2"].prizeCents = 2500;
legacy.used["play-3"].prizeCents = 50;
const restoredLegacy = restore(JSON.stringify(legacy));
assert.deepEqual(restoredLegacy.balances, wallet.balances);
assert.deepEqual(restoredLegacy.totals, { prizeCents: 3050, entryCents: 1200 });
assert.equal(settle(restoredLegacy, "play-2", 2500), restoredLegacy, "Historical callbacks remain idempotent");
assert.deepEqual(JSON.parse(serialize(restore(serialize(restoredLegacy)))), JSON.parse(serialize(restoredLegacy)));
for (const retired of [50, 2500]) assert.throws(() => settle(insert(wallet, "retired-prize", 0), "retired-prize", retired), "Retired amounts cannot settle a new play");
for (const prize of [100, 150, 200, 300, 500, 1000, 2000]) {
  const settled = settle(insert(wallet, "new-prize", 0), "new-prize", prize);
  assert.equal(settled.totals.prizeCents, wallet.totals.prizeCents + prize);
}
const forged = JSON.parse(serialize(wallet)); forged.balances = [9999, 9999, 9999]; forged.totals = { prizeCents: 999999, entryCents: 0 };
assert.deepEqual(JSON.parse(serialize(restore(JSON.stringify(forged)))), wallet, "Saved counts are derived from receipts");
assert.throws(() => insert(createTokenWallet(), "empty", 0));
assert.throws(() => settle(createTokenWallet(), "free", 2000));
for (const value of [-1, 3, .5, NaN, Infinity]) assert.throws(() => tokenTier(value));
for (const qty of [-1, 0, MAX_TOKEN_QUANTITY + 1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(isTokenQuantity(qty), false);
  assert.throws(() => buy(wallet, "invalid", 0, qty));
}
const customWallet = buy(createTokenWallet(), "custom-37", 2, 37);
assert.deepEqual(customWallet.balances, [0, 0, 37], "Custom quantities above 20 issue the exact selected tier count");
assert.deepEqual(customWallet.totals, createTokenWallet().totals, "Unused custom tokens do not change winnings");
assert.equal(buy(customWallet, "custom-37", 2, 37), customWallet, "Custom batch retries cannot duplicate credits");
assert.deepEqual(JSON.parse(serialize(restore(serialize(customWallet)))), customWallet, "Custom receipts survive reload");
const fullWallet = buy(createTokenWallet(), "max-batch", 0, MAX_TOKEN_QUANTITY);
assert.equal(fullWallet.balances[0], MAX_TOKEN_QUANTITY);
assert.deepEqual(JSON.parse(serialize(restore(serialize(fullWallet)))), fullWallet);
assert.throws(() => buy(fullWallet, "overflow", 0, 1), "Custom purchases still respect the existing wallet balance cap");
for (const prize of [-1, .5, NaN, 99]) assert.throws(() => settle(insert(wallet, "invalid-result", 0), "invalid-result", prize));
for (const raw of [null, "invalid", "{}", JSON.stringify({ ...wallet, baseTotals: null }), JSON.stringify({ ...wallet, pending: { id: "play-2", tier: 1 } }), JSON.stringify({ ...wallet, purchases: { bad: { tier: 0, quantity: MAX_TOKEN_QUANTITY + 1 } } }), "x".repeat(2_000_001)]) assert.deepEqual(restore(raw), createTokenWallet());
assert.notEqual(tokenWalletKey("alice"), tokenWalletKey("bob"));
assert(!tokenWalletKey("alice").includes(new Date().toISOString().slice(0, 10)), "Balances are independent of daily pile resets");
// Withdrawals operate on gross prizes, preserving historical wins and preventing overlapping claims.
let cash = buy(createTokenWallet({prizeCents:1000,entryCents:2000}),"cash-buy",2,10);
cash = settle(insert(cash,"session-win",2),"session-win",200);
const sessionIds=["session-win"];
assert.equal(availableWinningsCents(cash),1200);
assert.equal(sessionWithdrawableCents(cash,"session-a",sessionIds),200);
assert.equal(sessionWithdrawableCents(cash,"session-a",[...sessionIds,...sessionIds]),200,"Duplicate session IDs cannot duplicate prizes");
const allFirst=withdrawDemoWinnings(cash,"all-first","all","session-a",sessionIds);
assert.equal(availableWinningsCents(allFirst),0);assert.equal(sessionWithdrawableCents(allFirst,"session-a",sessionIds),0,"All-available cash-out also consumes session funds");
assert.equal(JSON.stringify(restore(serialize(allFirst)).withdrawals),JSON.stringify(allFirst.withdrawals));
const gross=JSON.stringify(cash.totals), balances=JSON.stringify(cash.balances);
cash=withdrawDemoWinnings(cash,"withdraw-session","session","session-a",sessionIds);
assert.equal(availableWinningsCents(cash),1000);assert.equal(sessionWithdrawableCents(cash,"session-a",sessionIds),0);
assert.equal(withdrawnPrizeCents(cash),200);
assert.equal(JSON.stringify(cash.totals),gross,"Gross lifetime earnings never decrease on withdrawal");
assert.equal(JSON.stringify(cash.balances),balances,"Withdrawing prizes cannot alter prepaid tokens");
assert.equal(withdrawDemoWinnings(cash,"withdraw-session","session","session-a",sessionIds),cash,"Retries withdraw once");
assert.throws(()=>withdrawDemoWinnings(cash,"withdraw-session","all","session-a",sessionIds));
assert.throws(()=>withdrawDemoWinnings(cash,"second-session-withdraw","session","session-a",sessionIds),"Session prizes cannot be claimed again from an older available balance");
cash=withdrawDemoWinnings(cash,"withdraw-all","all","session-a",sessionIds);
assert.equal(availableWinningsCents(cash),0);assert.equal(withdrawnPrizeCents(cash),1200);
assert.equal(JSON.stringify(cash.totals),gross);
assert.deepEqual(JSON.parse(serialize(restore(serialize(cash)))),cash,"Withdrawal receipts survive reload without restoring spent winnings");
assert.throws(()=>withdrawDemoWinnings(cash,"empty-all","all","session-a",sessionIds));
cash=settle(insert(cash,"later-win",2),"later-win",150);
assert.equal(availableWinningsCents(cash),150);
assert.equal(sessionWithdrawableCents(cash,"session-a",[...sessionIds,"later-win"]),150,"New wins after withdrawing everything remain available");
const later=withdrawDemoWinnings(cash,"later-withdraw","all","session-a",[...sessionIds,"later-win"]);
assert.equal(availableWinningsCents(later),0);assert.equal(sessionWithdrawableCents(later,"session-a",[...sessionIds,"later-win"]),0);
assert.equal(sessionWithdrawableCents(cash,"new-session",[]),0,"A new session cannot relabel historical earnings");
const legacyWallet=JSON.parse(serialize(wallet));delete legacyWallet.withdrawals;
assert.deepEqual(JSON.parse(serialize(restore(JSON.stringify(legacyWallet)))),wallet,"Existing balances migrate without withdrawal deductions");
for(const bad of [null,[],{bad:{cents:1,sessionCents:2,sessionId:"a",scope:"all"}},{bad:{cents:999999,sessionCents:0,sessionId:"a",scope:"all"}},{bad:{cents:1.5,sessionCents:0,sessionId:"a",scope:"all"}},{bad:{cents:1,sessionCents:0,sessionId:"a",scope:"session"}}]){
 const raw=JSON.parse(serialize(wallet));raw.withdrawals=bad;
 assert.deepEqual(restore(JSON.stringify(raw)),createTokenWallet(),"Invalid withdrawal receipts cannot restore a credited balance");
}
for(const [id,scope,sessionId] of [["","all","s"],["valid","other","s"],["valid","all",""]])assert.throws(()=>withdrawDemoWinnings(cash,id,scope,sessionId,[]));
console.log("PASS: session/all withdrawals share one balance, gross earnings preserved, idempotent receipts, new wins after cash-out, legacy migration and malformed/overdrawn storage rejection.");
const jsxSource=ts.transpileModule(await readFile(new URL("../components/claw/WithdrawalDialog.tsx",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext,jsx:ts.JsxEmit.ReactJSX}}).outputText;
const usdcStub=url('import {createElement} from '+JSON.stringify(import.meta.resolve("react"))+';export default function Amount({value}){return createElement("span",null,value," USDC");}');
const dialogJs=jsxSource.replace('"react"',JSON.stringify(import.meta.resolve("react"))).replace('"react/jsx-runtime"',JSON.stringify(import.meta.resolve("react/jsx-runtime"))).replace('"./UsdcAmount"',JSON.stringify(usdcStub)).replace('"react-icons/hi2"',JSON.stringify(url('export const HiOutlineXMark=()=>null;'))).replace(/"\.\/[^"\n]+\.module\.css"/g,JSON.stringify(url('export default {};')));
const {default:WithdrawalDialog}=await import(url(dialogJs));let payouts=0;
for(const [availableCents,sessionCents] of [[1200,200],[1000,0],[0,0]]){
 const html=renderToStaticMarkup(createElement(WithdrawalDialog,{totalCents:1400,availableCents,sessionCents,onWithdraw(){payouts++;return 0;},onClose(){}}));
 assert(html.includes("Demo withdrawal. No wallet transfer is sent."));
 assert(html.includes("Previously withdrawn") && html.includes("14.00 USDC"));
 assert(html.includes("This session")&&html.includes("All available winnings"));
 assert(html.includes((availableCents/100).toFixed(2)+" USDC"));
 assert(html.includes("RECORD DEMO WITHDRAWAL"));
 if(!availableCents)assert(/type="submit"[^>]*disabled/.test(html));
}
assert.equal(payouts,0,"Rendering or opening withdrawal cannot spend a balance");
console.log("PASS: withdrawal dialog discloses demo behavior, separates session/all choices and disables zero-balance submission.");
const modelSource = (await compile("createTokenModel")).replace('"./materialTextures"', JSON.stringify(surface)).replace('"./tokens"', JSON.stringify(tokens)).replace('"three"', JSON.stringify(import.meta.resolve("three")));
const { createTokenModel } = await import(url(modelSource));
const artwork = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat);
for (const tier of [0, 1, 2]) {
  const model = createTokenModel(tier, artwork);
  const faces = model.children.filter(mesh => mesh.name === "CATO mascot coin face");
  assert.equal(faces.length, 2, "Every tier prints the supplied mascot on both sides");
  assert(faces.every(face => face.material.map === artwork && face.material.transparent), "Coin decals preserve the supplied transparent artwork");
  assert(model.children.every(mesh => mesh.isMesh), "Coins use actual 3D meshes");
  model.scale.setScalar(.4); model.rotation.y = Math.PI / 2;
  const size = new THREE.Box3().setFromObject(model).getSize(new THREE.Vector3());
  assert(size.x < .105 && size.y < .33, `Tier ${tier} coin fits cabinet aperture edge first`);
  if (tier === 2) assert(model.children.some(mesh => mesh.geometry.type === "OctahedronGeometry"));
  const geometries = new Set(), materials = new Set();
  model.traverse(mesh => { if (mesh.isMesh) { geometries.add(mesh.geometry); materials.add(mesh.material); } });
  geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose());
}
console.log("PASS: tier pricing, preset/custom batches, quantity and balance limits, idempotent purchases/plays, insertion/ejection, no free plays, locked costs, persistence, invalid storage, player isolation and real 3D coins fitting the slot.");
const insertionSource = (await compile("tokenInsertion")).replace('"three"', JSON.stringify(import.meta.resolve("three")));
const { tokenInsertionPose, TOKEN_SCALE } = await import(url(insertionSource));
const slot = new THREE.Vector3(.68, -.6, 1.57);
// Conservative world bounds include the sloped deck and all of its control hardware.
const controls = new THREE.Box3(new THREE.Vector3(-1.6, -.34, 1.25), new THREE.Vector3(1.6, .5, 1.94));
for (const tier of [0, 1, 2]) {
  const model = createTokenModel(tier, artwork); model.scale.setScalar(TOKEN_SCALE);
  for (let frame = 0; frame <= 200; frame++) {
    const pose = tokenInsertionPose(slot, frame / 200); model.position.copy(pose.position); model.rotation.set(0, pose.rotationY, 0);
    const bounds = new THREE.Box3().setFromObject(model);
    assert(!bounds.intersectsBox(controls), `Tier ${tier} token intersects control deck at ${frame}`);
    if (bounds.min.z < slot.z + .064) {
      assert(bounds.min.x >= slot.x - .0525 && bounds.max.x <= slot.x + .0525, "Coin fits horizontally before crossing slot face");
      assert(bounds.min.y >= slot.y - .165 && bounds.max.y <= slot.y + .165, "Coin fits vertically before crossing slot face");
    }
    if (frame === 200) assert(bounds.max.z < slot.z + .064, "Coin fully enters the aperture before the claw drops");
  }
  const geometry = new Set(), material = new Set(), texture = new Set();
  model.traverse(mesh => { if (mesh.isMesh) { geometry.add(mesh.geometry); material.add(mesh.material); Object.values(mesh.material).forEach(value => { if (value?.isTexture) texture.add(value); }); } });
  geometry.forEach(item => item.dispose()); material.forEach(item => item.dispose()); texture.forEach(item => item.dispose());
}
console.log("PASS: all three tokens clear the control deck across 201 insertion poses, turn outside the machine and fit the real slot aperture before auto-drop.");
