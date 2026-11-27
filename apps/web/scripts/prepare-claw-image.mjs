import {readFile,mkdir,readdir,copyFile} from "node:fs/promises";
import {createHash} from "node:crypto";

const manifest=JSON.parse(await readFile(new URL("../onchain/deployment.devnet.json",import.meta.url),"utf8"));
const from=new URL("../onchain/artifacts/devnet/ready/",import.meta.url),to=new URL("../../../deploy/claw-backend/artifacts/",import.meta.url);
const names=["claw_vrf_probe.so","cluster.txt","program-id.txt","admin-authority.txt","source-commit.txt","program-bytes.txt","SHA256SUMS","Cargo.lock"];
const binary=await readFile(new URL(names[0],from)),hash=createHash("sha256").update(binary).digest("hex");
if(binary.length!==manifest.verifiedArtifact.bytes||hash!==manifest.verifiedArtifact.sha256)throw Error("cashier_image_binary_mismatch");
for(const [name,expected]of [["cluster.txt","devnet"],["program-id.txt",manifest.vrfProbeProgram],["admin-authority.txt",manifest.adminAuthority],["source-commit.txt",manifest.verifiedArtifact.sourceCommit],["program-bytes.txt",String(binary.length)]]){
  if((await readFile(new URL(name,from),"utf8")).trim()!==expected)throw Error("cashier_image_metadata_mismatch");
}
await mkdir(to,{recursive:true});
if((await readdir(to)).some(name=>!names.includes(name)))throw Error("unexpected_file_in_public_artifact_directory");
for(const name of names)await copyFile(new URL(name,from),new URL(name,to));
console.log(JSON.stringify({ready:true,cluster:"devnet",bytes:binary.length,sha256:hash,privateStateCopied:false}));
