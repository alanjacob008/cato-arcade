// Prepares unsigned owner/funder approvals only. Never reads a wallet secret or broadcasts.
import {readFile} from "node:fs/promises";
import {parseArgs} from "node:util";
import {PublicKey,SystemProgram} from "@solana/web3.js";
import {SPONSOR_DEFAULTS,sponsorshipAddress,sponsorshipInstruction} from "./lib/claw-sponsorship-chain.mjs";
const {values,positionals}=parseArgs({allowPositionals:true,options:{owner:{type:"string"},keeper:{type:"string"},recipients:{type:"string"},from:{type:"string"},lamports:{type:"string"}}});
const manifest=JSON.parse(await readFile(new URL("../onchain/sponsorship.devnet.json",import.meta.url),"utf8"));
const owner=new PublicKey(values.owner),[vault]=sponsorshipAddress(manifest,owner),action=positionals[0];
const policy={...SPONSOR_DEFAULTS,authorizedUntil:Math.floor(Date.now()/1000)+SPONSOR_DEFAULTS.policySeconds};
let instruction,description;
if(action==="initialize"||action==="configure"){
  instruction=sponsorshipInstruction(manifest,owner,action,{keeper:values.keeper,recipients:values.recipients?.split(","),policy});
  description="Authorize fixed VRF recipients; replenish below 0.002 up to 0.005 devnet SOL, maximum 0.05/day and 0.25 total, seven-day policy. No deposit included.";
}else if(action==="pause"||action==="resume"){
  instruction=sponsorshipInstruction(manifest,owner,"set_paused",{paused:action==="pause"});description=action+" automatic devnet SOL refills";
}else if(action==="deposit"){
  const lamports=Number(values.lamports);if(!Number.isSafeInteger(lamports)||lamports<=0||lamports>1e9)throw Error("deposit_must_be_explicit_positive_lamports_at_most_one_sol");
  instruction=SystemProgram.transfer({fromPubkey:new PublicKey(values.from),toPubkey:vault,lamports});description=`Deposit ${lamports} lamports into devnet vault. This unsigned plan does not transfer funds.`;
}else if(action==="withdraw"){
  instruction=sponsorshipInstruction(manifest,owner,"withdraw",{lamports:Number(values.lamports)});description="Owner-only withdrawal; vault must already be paused. Rent remains.";
}else throw Error("Usage: sponsorship-admin-cli.mjs initialize|configure|pause|resume|deposit|withdraw --owner PUBLIC_KEY [--keeper PUBLIC_KEY --recipients FOUR_COMMA_SEPARATED_KEYS] [--from PUBLIC_KEY --lamports INTEGER]");
console.log(JSON.stringify({cluster:"devnet",broadcast:false,program:manifest.program,vault:vault.toBase58(),owner:owner.toBase58(),description,
  ...(action==="initialize"||action==="configure"?{policy}:{}),instruction:{programId:instruction.programId.toBase58(),keys:instruction.keys.map(key=>({...key,pubkey:key.pubkey.toBase58()})),data:instruction.data.toString("base64")}},null,2));
