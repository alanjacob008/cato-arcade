import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {randomUUID} from "node:crypto";
import vm from "node:vm";
import ts from "typescript";

const storage=new Map(),requests=[],wallet="fixture-wallet",compiled={exports:{}};
const state={namespace:"devnet-usdc-v1",wallet,paymentsEnabled:true,withdrawableCents:100};
const fetch=async(url,options={})=>{
  const body=options.body?JSON.parse(options.body):null;let value;
  if(url.endsWith("/challenge"))value={id:"challenge",message:"fixture message"};
  else if(url.endsWith("/login"))value={token:"a".repeat(64),state};
  else if(url.endsWith("/withdraw")){requests.push(body);value={payment:{id:"claim-"+requests.length,status:"reserved",cents:100},state};}
  else if(url.includes("/withdrawal?id="))value={payment:{id:"claim-"+requests.length,status:requests.length===1?"failed":"paid",cents:100,signature:"fixture"},state};
  else throw Error("Unexpected client request");
  return {ok:true,json:async()=>value};
};
const source=ts.transpileModule(await readFile(new URL("../components/claw/authoritativeClient.ts",import.meta.url),"utf8"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
vm.runInNewContext(source,{exports:compiled.exports,module:compiled,fetch,Date,AbortSignal,TextEncoder,setTimeout,clearTimeout,
  crypto:{randomUUID},sessionStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)}});
const client=compiled.exports.createAuthoritativeClient({address:()=>wallet,connect:async()=>wallet,signMessage:async()=>new Uint8Array(64),signTransaction:async value=>value});await client.connect();
await assert.rejects(client.withdraw("all"),/Withdrawal failed onchain/);
const second=await client.withdraw("all");assert.equal(second.payment.status,"paid");
assert.notEqual(requests[0].requestId,requests[1].requestId,"A finalized failed payout must not permanently pin the next cash-out to its failed request ID");
assert.equal([...storage.keys()].filter(key=>key.includes("withdraw")).length,0);
console.log("PASS: the real browser client clears finalized-failure intents, creates a fresh cash-out request after balance restoration, and clears completed withdrawal recovery state.");
