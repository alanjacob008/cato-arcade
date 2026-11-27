import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise the real exit code: the final cover must visibly finish before the
// scene is revealed; intermediate loader swaps and failures are not completion.
const source=await readFile(new URL("../components/claw/ArcadeLoading.tsx",import.meta.url),"utf8");
const ast=ts.createSourceFile("ArcadeLoading.tsx",source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const names=new Set(["EXIT_MS","REDUCED_EXIT_MS","COMPLETE_HOLD_MS","live","leaving"]);
const code=ast.statements.filter(node=>ts.isVariableStatement(node)?node.declarationList.declarations.some(d=>names.has(d.name.getText(ast))):ts.isFunctionDeclaration(node)&&["fadeOut","settleExits"].includes(node.name?.text)).map(node=>node.getText(ast)).join("\n");
const js=ts.transpileModule(code+"\nglobalThis.exit=(batch,full=0,compact=0)=>{leaving=batch;live.full=full;live.compact=compact;settleExits();};",{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function rig(reduced=false){
 let now=0,reveals=0;const timers=[],mounted=new Set();
 const context={document:{body:{appendChild:copy=>mounted.add(copy)}},window:{location:{pathname:"/claw/play"},setTimeout:(callback,ms)=>timers.push({callback,at:now+ms})},prefersReducedMotion:()=>reduced,isArcadeRoute:path=>path.startsWith("/claw"),announceArcadeReveal:()=>reveals++};
 runInNewContext(js,context);
 function advance(ms){const until=now+ms;for(;;){timers.sort((a,b)=>a.at-b.at);if(!timers[0]||timers[0].at>until)break;const timer=timers.shift();now=timer.at;timer.callback();}now=until;}
 function cover(failed=false){
  const letters=Array.from({length:10},()=>({dataset:{}})),count={},label={},bar={style:{width:"75%"}},track={attrs:{},setAttribute(key,value){this.attrs[key]=value;}};
  const nodes={"[data-loading-count]":count,"[data-loading-label]":label,"[data-loading-track] > span":bar,"[data-loading-track]":track};
  const copy={dataset:failed?{failed:"true"}:{},querySelector:key=>nodes[key],querySelectorAll:()=>letters,addEventListener:(_type,callback)=>copy.end=callback,remove:()=>mounted.delete(copy)};
  return {copy,letters,count,label,bar,track};
 }
 return {context,advance,cover,mounted,get reveals(){return reveals;}};
}
const done=rig(),full=done.cover(),compact=done.cover();done.context.exit([{copy:full.copy,compact:false},{copy:compact.copy,compact:true}]);
assert.equal(done.mounted.size,1,"Only the topmost cover is kept");
assert.equal(full.count.textContent,"100%");assert.equal(full.bar.style.width,"100%");assert.equal(full.track.attrs["aria-valuenow"],"100");assert(full.letters.every(letter=>letter.dataset.lit&&letter.dataset.steady));
assert.equal(full.copy.dataset.exit,undefined);assert.equal(done.reveals,0);
done.advance(499);assert.equal(full.copy.dataset.exit,undefined,"Completion gets a readable hold before fading");
done.advance(1);assert.equal(full.copy.dataset.exit,"true");assert.equal(done.reveals,0,"Neon must wait until the cover is gone");
full.copy.end({target:full.copy});assert.equal(done.mounted.size,0);assert.equal(done.reveals,1);
done.advance(2000);assert.equal(done.reveals,1,"Animation event and fallback cannot reveal twice");
const swap=rig(),intermediate=swap.cover();swap.context.exit([{copy:intermediate.copy,compact:false}],0,1);assert.equal(intermediate.count.textContent,undefined);swap.advance(2000);assert.equal(swap.reveals,0,"A loader swap cannot claim readiness");
const failure=rig(),error=failure.cover(true);failure.context.exit([{copy:error.copy,compact:false}]);failure.advance(2000);assert.equal(error.count.textContent,undefined);assert.equal(failure.reveals,0,"Errors cannot display 100%");
const navigation=rig(),old=navigation.cover();navigation.context.exit([{copy:old.copy,compact:false}]);navigation.context.window.location.pathname="/";navigation.advance(2000);assert.equal(navigation.reveals,0,"Leaving the arcade cancels its reveal");
const quiet=rig(true),reduced=quiet.cover();quiet.context.exit([{copy:reduced.copy,compact:false}]);assert.equal(reduced.count.textContent,"100%");assert.equal(reduced.copy.dataset.exit,"true");quiet.advance(600);assert.equal(quiet.reveals,1);
console.log("PASS: fully lit 100% completion, readable hold, fade before reveal, loader swaps, failures, navigation, reduced motion and single completion.");
