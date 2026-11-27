import {Keypair} from "@solana/web3.js";
import {POOL_SIZE} from "./vrf-er-pool.mjs";

/** Expand the original four-lane store without replacing a signer, receipt or lease. */
export async function preparePoolStore({session,adminAuthority,save}) {
  const previous=session.poolLanes;
  if(previous!==undefined&&(!Array.isArray(previous)||![4,POOL_SIZE].includes(previous.length)))throw Error("invalid_vrf_pool_store");
  const existing=previous??[];
  const readKey=lane=>{
    if(!lane||typeof lane.id!=="string"||!/^[a-zA-Z0-9-]{1,100}$/.test(lane.id)||!Array.isArray(lane.attempts)
      ||!Array.isArray(lane.key)||lane.key.length!==64||!lane.key.every(byte=>Number.isInteger(byte)&&byte>=0&&byte<=255))throw Error("invalid_vrf_pool_store");
    try{return Keypair.fromSecretKey(Uint8Array.from(lane.key));}catch{throw Error("invalid_vrf_pool_signers");}
  };
  const keys=existing.map(readKey),addresses=keys.map(key=>key.publicKey.toBase58());
  if(new Set(existing.map(lane=>lane.id)).size!==existing.length)throw Error("invalid_vrf_pool_store");
  if(new Set(addresses).size!==keys.length||addresses.includes(adminAuthority))throw Error("invalid_vrf_pool_signers");
  if(existing.length===POOL_SIZE)return keys;
  const expanded=[...existing],ids=new Set(existing.map(lane=>lane.id));
  let number=existing.length+1;
  while(expanded.length<POOL_SIZE){
    let id;do{id=`lane-${number++}`;}while(ids.has(id));
    const key=Keypair.generate(),address=key.publicKey.toBase58();
    if(address===adminAuthority||addresses.includes(address))throw Error("invalid_vrf_pool_signers");
    ids.add(id);addresses.push(address);keys.push(key);
    expanded.push({id,key:Array.from(key.secretKey),attempts:[]});
  }
  session.poolLanes=expanded;
  try{await save();}catch(error){
    // No chain reads, authorization plans or sends occur before this durable write.
    if(previous===undefined)delete session.poolLanes;else session.poolLanes=previous;
    throw error;
  }
  return keys;
}
