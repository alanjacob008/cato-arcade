import {singleFlightCache} from "./vrf-rpc-transport.mjs";

// Admin-only, read-only measurements made inside the actual backend container.
// No URL, credentials, signer state, wallet balance or arbitrary query is returned.
export function createClawLatencyProbe({database,base,rollup,attestBase,attestRollup,saveStats,region,now=()=>performance.now()}){
  const measure=async work=>{const start=now();try{await work();return {ok:true,ms:Math.round(now()-start)};}
    catch(error){return {ok:false,ms:Math.round(now()-start),error:/^[a-z_]+$/.test(error.message)?error.message:"latency_probe_failed"};}};
  return singleFlightCache(async()=>{
    const names=["database","solanaRpc","rollupRpc","solanaAttestation","rollupAttestation"];
    const work=[database,base,rollup,attestBase,attestRollup];
    const results=await Promise.all(work.map(fn=>fn?measure(fn):Promise.resolve({skipped:true})));
    return {checkedAt:new Date().toISOString(),region:/^[a-z]{3}[0-9]$/.test(region??"")?region:"unknown",
      scope:"Read-only warm-path timings from this backend. Attestation caches may apply. No VRF request is made.",
      probes:Object.fromEntries(names.map((name,i)=>[name,results[i]])),signerWrites:saveStats?.()??null};
  },10000);
}
