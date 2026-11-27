import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

export function clawRuntimeConfig(env,root,er=true) {
  const hosted=env.CLAW_HOSTED==="1",paymentsEnabled=env.CLAW_ENABLE_DEVNET_PAYMENTS==="1";
  const port=Number(env.PORT||env.CLAW_PORT||(er?4322:4321));
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error("invalid_claw_port");
  function origin(value,local=false){const url=new URL(value);if(url.origin!==value||url.username||url.password
    ||!(url.protocol==="https:"||local&&url.protocol==="http:"&&url.hostname==="127.0.0.1"))throw Error("invalid_claw_origin");return url;}
  const service=origin(hosted?env.CLAW_SERVICE_ORIGIN:`http://127.0.0.1:${port}`,!hosted);
  const player=origin(env.CLAW_PUBLIC_ORIGIN||service.origin,!hosted);
  // CLAW_DATABASE_URL_ENV names another server-only variable holding the URL (e.g. the Neon integration's DATABASE_URL_UNPOOLED).
  const urlEnv=env.CLAW_DATABASE_URL_ENV||"";
  if(urlEnv&&(!/^[A-Z][A-Z0-9_]*$/.test(urlEnv)||urlEnv.startsWith("NEXT_PUBLIC_")||urlEnv.startsWith("VITE_")))throw Error("invalid_claw_database_url_env");
  const databaseUrl=env.CLAW_DATABASE_URL||(urlEnv?env[urlEnv]||"":"");
  // With CLAW_STATE_KEY the signer session is sealed into Postgres instead of CLAW_STATE_DIR (no persistent disk needed).
  const stateKey=env.CLAW_STATE_KEY||null;
  if(stateKey&&!/^[a-f0-9]{64}$/.test(stateKey))throw Error("invalid_claw_state_key");
  // Set by the Vercel image (no disk): without the key every cold start would silently create new signers.
  if(env.CLAW_REQUIRE_STATE_KEY==="1"&&!stateKey)throw Error("claw_state_key_required");
  if((hosted||paymentsEnabled||stateKey)&&!databaseUrl)throw Error("claw_database_required");
  if(hosted&&!/^[a-f0-9]{64}$/.test(env.VRF_LOCAL_SESSION_TOKEN||""))throw Error("hosted_admin_capability_required");
  const frontendPort=Number(env.CLAW_FRONTEND_PORT||4331);
  if(!Number.isInteger(frontendPort)||frontendPort<1024||frontendPort>65535)throw Error("invalid_claw_frontend_port");
  const statePath=resolve(root,env.CLAW_STATE_DIR||"onchain/artifacts/devnet");
  if(/(?:^|[/\\])(?:public|node_modules|\.git)(?:[/\\]|$)/i.test(statePath))throw Error("invalid_claw_state_directory");
  return {hosted,paymentsEnabled,databaseUrl,stateKey,port,bind:hosted?"0.0.0.0":"127.0.0.1",expectedHost:service.host,
    origin:service.origin,playerOrigin:player.origin,frontendPort,stateDirectory:pathToFileURL(statePath+"/")};
}
