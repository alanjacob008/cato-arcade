// Player authentication is separate from the private localhost admin capability.
export function createPlayerApi({ledger,availability,origin,payments=null}) {
  return async function handle(req,url,respond) {
    if (!url.pathname.startsWith("/api/player/")) return false;
    const route=url.pathname.slice("/api/player/".length);
    try {
      if (req.method==="GET" && route==="availability") {respond(200,await availability());return true;}
      const get=["state","result",...(payments?["cashier","purchase","withdrawal"]:[])].includes(route),post=["challenge","login","logout","play","resume","test-credit",...(payments?["purchase-plan","purchase-submit","withdraw"]:[])].includes(route);
      if (!(get&&req.method==="GET"||post&&req.method==="POST")) {respond(404,{error:"not_found"});return true;}
      if (req.method==="POST" && (req.headers.origin!==origin||req.headers["content-type"]!=="application/json")) throw Error("invalid_origin_or_method");
      // Authenticate before accepting large bodies. Sign-in has no financial mutation.
      const wallet=["challenge","login"].includes(route)?null:await ledger.authenticate(req.headers["x-cato-player-session"]);
      let body;
      if (req.method==="POST") {let raw="";for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>2048)throw Error("request_too_large");}try{body=JSON.parse(raw);}catch{throw Error("invalid_player_request");}}
      let value;
      if(route==="challenge") {if(!body||Object.keys(body).join()!=="wallet")throw Error("invalid_player_request");value=await ledger.challenge(body.wallet);}
      else if(route==="login")value=await ledger.login(body);
      else if(route==="logout"){if(!body||typeof body!=="object"||Array.isArray(body)||Object.keys(body).length)throw Error("invalid_player_request");value=await ledger.logout(req.headers["x-cato-player-session"]);}
      else if(route==="state")value=await ledger.state(wallet);
      else if(route==="result")value=await ledger.result(wallet,url.searchParams.get("id"));
      else if(route==="play")value=await ledger.play(wallet,body);
      else if(route==="test-credit")value=await ledger.creditTest(wallet,body);
      else if(route==="cashier")value=await payments.status();
      else if(route==="purchase-plan")value=await payments.purchasePlan(wallet,body);
      else if(route==="purchase-submit")value=await payments.purchaseSubmit(wallet,body);
      else if(route==="purchase")value=await payments.purchaseStatus(wallet,url.searchParams.get("id"));
      else if(route==="withdraw")value=await payments.withdraw(wallet,req.headers["x-cato-player-session"],body);
      else if(route==="withdrawal")value=await payments.withdrawalStatus(wallet,url.searchParams.get("id"));
      else {if(!body||Object.keys(body).join()!=="id")throw Error("invalid_player_request");value=await ledger.result(wallet,body.id,true);}
      const summaryTarget=value?.state??(["state","test-credit"].includes(route)?value:null);
      if(ledger.sessionSummary&&summaryTarget)Object.assign(summaryTarget,await ledger.sessionSummary(route==="login"?value.token:req.headers["x-cato-player-session"]));
      else {
        if(route==="login")value.state.sessionWinningsCents=await ledger.sessionWinnings(value.token);
        else if(wallet&&route==="state")value.sessionWinningsCents=await ledger.sessionWinnings(req.headers["x-cato-player-session"]);
        else if(wallet&&value?.state)value.state.sessionWinningsCents=await ledger.sessionWinnings(req.headers["x-cato-player-session"]);
        else if(wallet&&route==="test-credit")value.sessionWinningsCents=await ledger.sessionWinnings(req.headers["x-cato-player-session"]);
        if(wallet&&ledger.sessionWithdrawable){const target=value?.state??(route==="state"||route==="test-credit"?value:null);if(target)target.sessionWithdrawableCents=await ledger.sessionWithdrawable(req.headers["x-cato-player-session"]);}
      }
      respond(200,value);
    }catch(error){const message=/^[a-z_]+$/.test(error.message)?error.message:"player_request_failed";respond(message==="player_authentication_required"?401:message==="claw_service_busy_retry"?503:400,{error:message});}
    return true;
  };
}
