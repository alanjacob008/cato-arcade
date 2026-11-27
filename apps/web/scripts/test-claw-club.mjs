import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";
const url = text => `data:text/javascript;base64,${Buffer.from(text).toString("base64")}`;
const modules = new Map();
async function module(name) {
  if (modules.has(name)) return modules.get(name);
  let source = ts.transpileModule(await readFile(new URL(`../components/claw/${name}.ts`, import.meta.url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
  for (const match of [...source.matchAll(/from "\.\/([^"\n]+)"/g)]) source = source.replace(`"./${match[1]}"`, JSON.stringify(await module(match[1])));
  const result = url(source); modules.set(name, result); return result;
}
const { clubProgress, clubReceipts, themeUnlocked } = await import(await module("clubCosmetics"));
const empty = clubProgress({}); assert.deepEqual(empty, { plays: 0, catches: 0, rareCatches: 0 });
assert(themeUnlocked("violet", empty)); assert(!themeUnlocked("afterglow", empty)); assert(!themeUnlocked("solar", empty));
const plays = { miss: { tier: 0, prizeCents: 0 }, catch: { tier: 1, prizeCents: 100 }, rare: { tier: 2, prizeCents: 2500 } };
const original = JSON.stringify(plays), progress = clubProgress(plays);
assert.deepEqual(progress, { plays: 3, catches: 2, rareCatches: 1 });
assert(themeUnlocked("afterglow", progress)); assert(themeUnlocked("solar", progress));
assert(!themeUnlocked("solar", clubProgress({ small: { prizeCents: 500 } })), "Small catches never unlock the rare cosmetic");
assert.deepEqual(clubReceipts(plays).map(receipt => [receipt.id, receipt.entryCents, receipt.prizeCents, receipt.netCents]), [["rare", 600, 2500, 1900], ["catch", 400, 100, -300], ["miss", 200, 0, -200]], "Receipt amounts use the actual token tier, prize and net cost");
assert.equal(JSON.stringify(plays), original, "Cosmetics cannot mutate play results or wallet records");
const many = Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`play-${i}`, { tier: 0, prizeCents: 0 }]));
assert.equal(clubReceipts(many).length, 50); assert.equal(clubReceipts(many)[0].id, "play-64"); assert.equal(clubReceipts(many).at(-1).id, "play-15");
console.log("PASS: local cosmetic unlocks, unchanged play records, real receipts, correct USDC net amounts and bounded newest-first history.");
