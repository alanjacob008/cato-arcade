import {Keypair} from "@solana/web3.js";
import {createPrivateKey,sign,randomUUID} from "node:crypto";
import {readFile,writeFile,mkdir} from "node:fs/promises";
import {loadClawRules} from "./lib/vrf-game.mjs";

// Explicit operator action only. These are real sponsored devnet draws, never a startup job.
const option=(name,fallback)=>process.argv.find(value=>value.startsWith(`--${name}=`))?.slice(name.length+3)??fallback;
// --player-origin: the site origin a hosted backend accepts (CLAW_PUBLIC_ORIGIN), when calling the backend directly.
const origin=option("origin","http://127.0.0.1:4322"),playerOrigin=option("player-origin",origin),url=new URL(origin),count=Number(option("count","5")),concurrency=Number(option("concurrency","4"));
// The loopback UI gateway uses its own browser Origin but retains the hosted
// site's canonical signed login message. No arbitrary cross-origin override.
const requestOrigin=option("request-origin",playerOrigin);
if(requestOrigin!==playerOrigin&&!(origin==="http://127.0.0.1:4334"&&requestOrigin===origin&&playerOrigin==="https://www.ogcato.com"))throw Error("invalid_preview_origin_configuration");
if(url.origin!==origin||url.username||url.password||!(url.protocol==="https:"||url.protocol==="http:"&&url.hostname==="127.0.0.1")
  ||new URL(playerOrigin).origin!==playerOrigin||!Number.isInteger(count)||count<1||count>10||!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error("invalid_live_check_configuration");
async function api(route,body,token){const response=await fetch(origin+"/api/player/"+route,{method:body===undefined?"GET":"POST",signal:AbortSignal.timeout(30000),
  headers:{...(token?{"X-Cato-Player-Session":token}:{}),...(body===undefined?{}:{Origin:requestOrigin,"Content-Type":"application/json"})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const value=await response.json();if(!response.ok)throw Error(/^[a-z_]+$/.test(value.error)?value.error:"live_check_request_failed");return value;}
const availability=await api("availability");
if(availability.cluster!=="devnet"||availability.execution!=="er"||!availability.deployed||!availability.sponsor.ready||availability.sponsor.remaining<count)throw Error("live_check_requires_authorized_devnet_pool");
const folder=new URL("../onchain/artifacts/devnet/",import.meta.url);await mkdir(folder,{recursive:true,mode:0o700});
const wallets=Array.from({length:count},()=>Keypair.generate());
await writeFile(new URL(`live-check-wallets-${Date.now()}.json`,folder),JSON.stringify(wallets.map(key=>Array.from(key.secretKey))),{mode:0o600});
const rules=await loadClawRules(),players=[];
for(const key of wallets){
  const wallet=key.publicKey.toBase58(),challenge=await api("challenge",{wallet});
  if(typeof challenge.message!=="string"||challenge.message.length>1500||!challenge.message.startsWith("CATO Arcade wallet sign-in\n")
    ||!challenge.message.includes(`Origin: ${playerOrigin}\n`)||!challenge.message.includes(`Wallet: ${wallet}\n`)||!challenge.message.includes("Cluster: devnet\n"))throw Error("live_check_challenge_mismatch");
  const privateKey=createPrivateKey({key:Buffer.concat([Buffer.from("302e020100300506032b657004220420","hex"),Buffer.from(key.secretKey.subarray(0,32))]),format:"der",type:"pkcs8"});
  const auth=await api("login",{id:challenge.id,wallet,signature:sign(null,Buffer.from(challenge.message),privateKey).toString("hex")});
  if(auth.state.paymentsEnabled||!['devnet-test-v1','devnet-test-pg-v1'].includes(auth.state.namespace)||auth.state.wallet!==wallet)throw Error("live_check_requires_free_test_namespace");
  players.push({wallet,token:auth.token,state:auth.state});
}
const results=[];
async function play(player){const {wallet,token,state}=player;
  const aim=state.boxes.map(box=>({x:box.grabPoint.x,z:box.grabPoint.z})).find(point=>{try{return !!rules.selectTarget(point,state.boxes,0);}catch{return false;}});
  if(!aim)throw Error("live_check_no_exposed_target");const start=Date.now();
  const locked=await api("play",{requestId:randomUUID(),revision:state.revision,aim,tier:0},token),prepared=Date.now();
  if(!locked.pull.target)throw Error("live_check_target_changed");
  for(let tries=0;tries<120;tries++){
    const result=await api(`result?id=${encodeURIComponent(locked.id)}`,undefined,token);
    if(result.result){const expected=rules.resolvePull(locked.pull,()=>result.result.roll,"magicblock-vrf");
      if(expected.success!==result.result.success||expected.cents!==result.result.cents||result.state.balances[0]!==state.balances[0]-1||result.state.winningsCents!==expected.cents)throw Error("live_check_settlement_mismatch");
      const receipt=result.state.history.find(row=>row.id===locked.id);if(!receipt?.requestSignature||!receipt.callbackSignature)throw Error("live_check_missing_verified_receipts");
      const timing=receipt.timings;
      const duration=(end,begin)=>Number.isSafeInteger(end)&&Number.isSafeInteger(begin)&&end>=begin?end-begin:null;
      results.push({id:locked.id,wallet,prepareHttpMs:prepared-start,pressToVerifiedMs:Date.now()-start,
        ...(timing?{serverTimings:{prepareMs:duration(timing.lockedAt,timing.preparationStartedAt),permitAndSigningMs:duration(timing.submittedAt,timing.lockedAt),
          persistBeforeSendMs:duration(timing.durableReadyAt,timing.submittedAt),sendToVerifiedMs:duration(timing.callbackVerifiedAt,timing.durableReadyAt),
          sendToAckMs:duration(timing.broadcastAt,timing.durableReadyAt)}}:{}),
        success:expected.success,cents:expected.cents,request:receipt.requestSignature,callback:receipt.callbackSignature});return;
    }await new Promise(resolve=>setTimeout(resolve,500));
  }throw Error("live_check_pending_resume_same_attempt");
}
for(let start=0;start<players.length;start+=concurrency){const group=await Promise.allSettled(players.slice(start,start+concurrency).map(play));
  if(group.some(row=>row.status==='rejected'))throw Error("live_check_incomplete_original_attempts_retained");}
try{const session=JSON.parse(await readFile(new URL("er-signing-session.json",folder),"utf8")),attempts=[...(session.attempts??[]),...(session.poolLanes??[]).flatMap(lane=>lane.attempts)];
  for(const result of results){const row=attempts.find(item=>item.gamePull?.id===result.id);if(row?.submittedAt&&row?.callbackVerifiedAt)result.sendToVerifiedMs=row.callbackVerifiedAt-row.submittedAt;}
}catch{/* Hosted proof remains valid without access to private local signer files. */}
const percentile=(values,p)=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?sorted[Math.ceil(sorted.length*p)-1]:null;};
const totals=results.map(row=>row.pressToVerifiedMs),vrf=results.map(row=>row.serverTimings?.sendToVerifiedMs).filter(value=>typeof value==="number");
const report={checkedAt:new Date().toISOString(),cluster:"devnet",origin,count,concurrency,scope:"Real free-token devnet API plays. Does not measure browser animation or full-play duration.",
  summary:{pressToVerifiedP50Ms:percentile(totals,.5),pressToVerifiedP95Ms:percentile(totals,.95),sendToVerifiedP50Ms:percentile(vrf,.5),sendToVerifiedP95Ms:percentile(vrf,.95),allWithinThreeSeconds:totals.every(ms=>ms<=3000)},results};
await writeFile(new URL("live-player-verification.json",folder),JSON.stringify(report,null,2)+"\n");console.log(JSON.stringify(report,null,2));
