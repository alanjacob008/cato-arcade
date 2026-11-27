import {readFile} from "node:fs/promises";
import ts from "typescript";
const loaded = new Map();
export async function clawModule(name) {
 if(loaded.has(name)) return loaded.get(name);
 const text=await readFile(new URL("../components/claw/"+name+".ts",import.meta.url),"utf8");
 let source=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 for(const match of [...source.matchAll(/from "([^"\n]+)"/g)]) {
  const dependency=match[1];
  const target=dependency.startsWith('./') ? await clawModule(dependency.slice(2)) : import.meta.resolve(dependency);
  source=source.replaceAll(JSON.stringify(dependency),JSON.stringify(target));
 }
 const url="data:text/javascript;base64,"+Buffer.from(source).toString("base64"); loaded.set(name,url); return url;
}
