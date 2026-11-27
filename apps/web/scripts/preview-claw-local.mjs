// Loopback-only development gateway: local UI, real free-token devnet API.
// No admin endpoints, stored credentials, paid requests or arbitrary proxy targets.
import {createServer} from "node:http";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
const require=createRequire(import.meta.url),httpProxy=require("next/dist/compiled/http-proxy");
export const PREVIEW_ORIGIN="http://127.0.0.1:4334";
const UI="http://127.0.0.1:4337",BACKEND="https://cato-claw-backend.vercel.app",PLAYER_ORIGIN="https://www.ogcato.com";
const GET=new Set(["availability","state","result"]),POST=new Set(["challenge","login","logout","play","resume","test-credit"]);
export function previewPlayerRequest({host,origin,method,path,fetchSite}){
  if(host!=="127.0.0.1:4334")return {status:403,error:"local_preview_host_required"};
  if(fetchSite==="cross-site"||origin&&origin!==PREVIEW_ORIGIN)return {status:403,error:"local_preview_origin_required"};
  const url=new URL(path,PREVIEW_ORIGIN),route=url.pathname.slice("/api/player/".length);
  if(!(method==="GET"&&GET.has(route)||method==="POST"&&POST.has(route)))return {status:404,error:"preview_route_not_available"};
  if(method==="POST"&&origin!==PREVIEW_ORIGIN)return {status:403,error:"local_preview_origin_required"};
  return null;
}
export function startPreview(){
  const proxy=httpProxy.createProxyServer({ws:true});
  proxy.on("error",(_error,_req,res)=>{if(res?.destroyed)return;if(res?.writeHead){if(!res.headersSent)res.writeHead(502,{"Content-Type":"application/json"});res.end(JSON.stringify({error:"preview_service_unavailable"}));}else res?.destroy();});
  proxy.on("proxyReq",(upstream,req,res)=>{
    if(!req.url.startsWith("/api/player/"))return;
    const cancel=()=>{if(!res.writableFinished)upstream.destroy();};
    res.once("close",cancel);
    upstream.once("close",()=>res.removeListener("close",cancel));
  });
  const server=createServer((req,res)=>{
    if(req.headers.host!=="127.0.0.1:4334"){res.writeHead(403);return res.end();}
    if(req.url.startsWith("/api/player/")){
      const rejected=previewPlayerRequest({host:req.headers.host,origin:req.headers.origin,method:req.method,path:req.url,fetchSite:req.headers["sec-fetch-site"]});
      if(rejected){res.writeHead(rejected.status,{"Content-Type":"application/json"});return res.end(JSON.stringify({error:rejected.error}));}
      // Preserve only player authentication. The backend still verifies a fresh
      // canonical-site login message and the signed-in wallet for every play.
      const allowed=new Set(["host","content-type","content-length","x-cato-player-session","accept","accept-encoding"]);
      for(const name of Object.keys(req.headers))if(!allowed.has(name))delete req.headers[name];
      req.headers.origin=PLAYER_ORIGIN;
      res.setHeader("Cache-Control","no-store");
      return proxy.web(req,res,{target:BACKEND,changeOrigin:true,secure:true,proxyTimeout:req.method==="GET"?8000:20000});
    }
    if(req.url.startsWith("/api/")){res.writeHead(404);return res.end();}
    proxy.web(req,res,{target:UI,changeOrigin:false});
  });
  server.on("upgrade",(req,socket,head)=>{
    if(req.headers.host!=="127.0.0.1:4334"||req.headers.origin&&req.headers.origin!==PREVIEW_ORIGIN||!req.url.startsWith("/_next/")){socket.destroy();return;}
    proxy.ws(req,socket,head,{target:UI});
  });
  server.listen(4334,"127.0.0.1",()=>console.log("Latest claw game: "+PREVIEW_ORIGIN+"/claw/play"));
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)startPreview();
