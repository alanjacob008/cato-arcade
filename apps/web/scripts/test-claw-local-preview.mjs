import assert from "node:assert/strict";
import {previewPlayerRequest,PREVIEW_ORIGIN} from "./preview-claw-local.mjs";
const request={host:"127.0.0.1:4334",origin:PREVIEW_ORIGIN,method:"POST",path:"/api/player/play",fetchSite:"same-origin"};
assert.equal(previewPlayerRequest(request),null);
for(const bad of [{host:"attacker.example"},{origin:"https://attacker.example"},{origin:undefined},{fetchSite:"cross-site"},{path:"/api/player/withdraw"},{path:"/api/player/purchase-plan"},{path:"/api/player/../state"},{path:"/api/player/play/../../submit"},{method:"OPTIONS"}])assert(previewPlayerRequest({...request,...bad}),JSON.stringify(bad));
assert.equal(previewPlayerRequest({...request,path:"/api/player/logout"}),null,"Sign-out is forwarded so the backend can revoke the session");
assert.equal(previewPlayerRequest({...request,method:"GET",path:"/api/player/result?id=locked-attempt",origin:undefined}),null);
console.log("PASS: loopback preview allows only fixed free-token player routes, preserves wallet authentication, and rejects foreign origins, traversal, payments and admin paths.");
