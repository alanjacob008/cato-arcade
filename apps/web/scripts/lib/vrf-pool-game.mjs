import {createHash} from "node:crypto";

// Single-process durable routing. Database-backed cross-host leases belong in
// the hosting phase; never run two independent copies of these signer files.
export function createPoolGame({store,lanes,save,enabled=()=>true,legacy=null}) {
  if(!Array.isArray(lanes)||!lanes.length||lanes.length>16||new Set(lanes.map(lane=>lane.id)).size!==lanes.length)throw Error("invalid_vrf_pool");
  store.version??=1;store.cursor??=0;store.assignments??={};
  if(store.version!==1||!Number.isSafeInteger(store.cursor)||store.cursor<0)throw Error("invalid_vrf_pool_store");
  const fingerprint=pull=>createHash("sha256").update(JSON.stringify(pull)).digest("hex");
  const inflight=new Map(),legacyInflight=new Map();let mutations=Promise.resolve(),legacyQueue=Promise.resolve();
  const atomic=fn=>{const next=mutations.then(fn);mutations=next.catch(()=>{});return next;};
  for(const [id,assignment] of Object.entries(store.assignments)) {
    if(!id||!lanes.some(lane=>lane.id===assignment.lane)||!["active","complete"].includes(assignment.phase)
      ||!/^[a-f0-9]{64}$/.test(assignment.fingerprint??""))throw Error("invalid_vrf_pool_store");
  }
  const active=()=>Object.values(store.assignments).filter(item=>item.phase==="active");
  for(const lane of lanes)if(active().filter(item=>item.lane===lane.id).length>1)throw Error("vrf_pool_double_lease");
  const locate=id=>lanes.find(lane=>lane.has(id));
  const boot=atomic(async()=>{
    // Recover old writes interrupted between game persistence and routing save.
    for(const lane of lanes)for(const attempt of lane.attempts())if(attempt.gamePull) {
      const id=attempt.gamePull.id,prior=store.assignments[id];
      if(prior&&(prior.lane!==lane.id||prior.fingerprint!==attempt.gameFingerprint))throw Error("vrf_pool_attempt_binding_mismatch");
      store.assignments[id]??={lane:lane.id,fingerprint:attempt.gameFingerprint,phase:attempt.callbackSignature?"complete":"active"};
      if(attempt.callbackSignature)store.assignments[id].phase="complete";
    }
    for(const lane of lanes)if(active().filter(item=>item.lane===lane.id).length>1)throw Error("vrf_pool_double_lease");
    await save();
  });
  // A startup error is also awaited by each request; avoid an unhandled promise.
  boot.catch(()=>{});
  function legacyPlan(pull) {
    const prior=legacyInflight.get(pull.id),hash=fingerprint(pull);
    if(prior){if(prior.fingerprint!==hash)throw Error("game_attempt_inputs_changed");return prior.work;}
    const work=legacyQueue.catch(()=>{}).then(()=>legacy.game.plan(pull)).finally(()=>legacyInflight.delete(pull.id));
    legacyQueue=work;legacyInflight.set(pull.id,{fingerprint:hash,work});return work;
  }
  async function finish(id,response) {
    if(response.result)await atomic(async()=>{
      if(!store.assignments[id])throw Error("vrf_pool_assignment_missing");
      if(store.assignments[id].phase==="complete")return;
      store.assignments[id].phase="complete";
      try{await save();}catch(error){store.assignments[id].phase="active";throw error;}
    });
    return response;
  }
  async function reserve(pull) {
    await boot;
    const hash=fingerprint(pull);
    const statuses=await Promise.allSettled(lanes.map(lane=>lane.available()));
    return atomic(async()=>{
      const prior=store.assignments[pull.id];
      if(prior){if(prior.fingerprint!==hash)throw Error("game_attempt_inputs_changed");return lanes.find(lane=>lane.id===prior.lane);}
      if(locate(pull.id))throw Error("vrf_pool_assignment_missing");
      const occupied=new Set(active().map(item=>item.lane));
      for(let n=0;n<lanes.length;n++){
        const index=(store.cursor+n)%lanes.length,lane=lanes[index],status=statuses[index];
        if(occupied.has(lane.id)||status.status!=="fulfilled"||!status.value?.ready||status.value.pending)continue;
        store.assignments[pull.id]={lane:lane.id,fingerprint:hash,phase:"active"};
        store.cursor=(index+1)%lanes.length;
        // Persist the lane before the first request is constructed or sent.
        await save();return lane;
      }
      throw Error("vrf_pool_busy_retry_same_attempt");
    });
  }
  return {
    concurrent:true,
    async plan(pull) {
      if(!pull||typeof pull.id!=="string"||!/^[a-zA-Z0-9-]{1,100}$/.test(pull.id))throw Error("invalid_game_attempt");
      await boot;
      if(legacy?.has(pull.id))return legacyPlan(pull);
      if(!enabled()&&!store.assignments[pull.id])return legacy?legacyPlan(pull):Promise.reject(Error("vrf_pool_setup_required"));
      if(inflight.has(pull.id)){
        if(inflight.get(pull.id).fingerprint!==fingerprint(pull))throw Error("game_attempt_inputs_changed");
        return inflight.get(pull.id).work;
      }
      const work=(async()=>{const lane=await reserve(pull);return finish(pull.id,await lane.game.plan(pull));})()
        .finally(()=>inflight.delete(pull.id));
      inflight.set(pull.id,{fingerprint:fingerprint(pull),work});return work;
    },
    async state(id) {
      await boot;
      const assignment=store.assignments[id];
      if(!assignment)return legacy?.has(id)?legacy.game.state(id):{pending:false,submitted:false,result:null,notFound:true};
      const lane=lanes.find(item=>item.id===assignment.lane);
      return finish(id,await lane.game.state(id));
    },
    async recordTiming(id,events) {
      await boot;
      const lane=lanes.find(item=>item.id===store.assignments[id]?.lane);
      if(lane)return lane.game.recordTiming(id,events);
      if(legacy?.has(id))return legacy.game.recordTiming(id,events);
      throw Error("verified_game_result_required");
    },
    async recover() {
      await boot;
      return Promise.allSettled(Object.entries(store.assignments).filter(([,value])=>value.phase==="active")
        .map(async([id,value])=>finish(id,await lanes.find(lane=>lane.id===value.lane).game.state(id))));
    },
    async idle(){await boot;await Promise.allSettled([...inflight.values()].map(item=>item.work));await mutations;},
    status(){return {size:lanes.length,occupied:active().length,queuedRouting:inflight.size};},
  };
}
