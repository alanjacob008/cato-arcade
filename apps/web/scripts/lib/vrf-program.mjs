import { createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { LOADER } from "./vrf-deployment.mjs";

export const LOADER_V4 = new PublicKey("LoaderV411111111111111111111111111111111111");

// ER clones can use loader-v4: the authority/status header and bytecode live in
// the program account itself. Keep the L1 loader-v3 verifier strict and separate.
const ELF_MAGIC = Buffer.from("7f454c46", "hex");
export function createRollupDeploymentVerifier({ connection, program, authority, binary, now = Date.now }) {
  let verifiedUntil = 0, verifiedHeader = null, pending = null;
  function headerOf(account) {
    const header = account?.data;
    if (!account?.owner.equals(LOADER_V4) || !account.executable || header?.length < 48
      || !header.subarray(8, 40).equals(authority.toBuffer()) || header.readBigUInt64LE(40) !== 1n)
      throw Error("rollup_program_owner_authority_or_status_mismatch");
    return header.subarray(0, 48);
  }
  async function verify() {
    const { context, value } = await connection.getAccountInfoAndContext(program, {
      commitment: "confirmed", dataSlice: { offset: 0, length: 48 },
    });
    if (!value) return false;
    // Current MagicBlock clones keep only the raw ELF (no loader-v4 header). The authority is verified on Solana L1;
    // here the rollup copy must be byte-for-byte the verified build. No header cache: the ELF header never changes.
    if (value.data?.subarray(0, 4).equals(ELF_MAGIC)) {
      if (!value.owner.equals(LOADER_V4) || !value.executable) throw Error("rollup_program_owner_authority_or_status_mismatch");
      const account = await connection.getAccountInfo(program, { commitment: "confirmed", minContextSlot: context.slot });
      if (!account?.owner.equals(LOADER_V4) || !account.executable) throw Error("rollup_program_owner_authority_or_status_mismatch");
      if (!account.data.equals(binary)) throw Error("rollup_program_binary_mismatch");
      verifiedHeader = null; verifiedUntil = now() + 30000; return true;
    }
    const header = headerOf(value);
    if (header.length !== 48) throw Error("rollup_program_header_mismatch");
    if (verifiedHeader?.equals(header)) { verifiedUntil = now() + 30000; return true; }
    const account = await connection.getAccountInfo(program, { commitment: "confirmed", minContextSlot: context.slot });
    if (!headerOf(account).equals(header)) throw Error("rollup_program_changed_during_verification_retry");
    const bytes = account.data.subarray(48);
    if (bytes.length < binary.length || !bytes.subarray(0, binary.length).equals(binary) || !bytes.subarray(binary.length).every(b => b === 0))
      throw Error("rollup_program_binary_mismatch");
    verifiedHeader = Buffer.from(header); verifiedUntil = now() + 30000; return true;
  }
  return () => {
    if (now() < verifiedUntil) return Promise.resolve(true);
    pending ??= verify().finally(() => { pending = null; });
    return pending;
  };
}

export function createDeploymentVerifier({ connection, program, authority, binary, previous, now = Date.now }) {
  const [address] = PublicKey.findProgramAddressSync([program.toBuffer()], LOADER);
  let verifiedUntil = 0, verifiedHeader = null, pending = null;
  async function verify() {
    const { context, value: [account, metadata] } = await connection.getMultipleAccountsInfoAndContext([program, address], {
      commitment: "confirmed", dataSlice: { offset: 0, length: 45 },
    });
    if (!account) return false;
    if (!account.owner.equals(LOADER) || !account.executable || account.data.length !== 36 || account.data.readUInt32LE(0) !== 2)
      throw Error("unexpected_program_account");
    if (!account.data.subarray(4).equals(address.toBuffer())) throw Error("programdata_address_mismatch");
    const header = metadata?.data;
    if (!metadata?.owner.equals(LOADER) || header?.length !== 45 || header.readUInt32LE(0) !== 3
      || header[12] !== 1 || !header.subarray(13).equals(authority.toBuffer())) throw Error("deployed_binary_or_authority_mismatch");
    // Loader-v3 updates the deployment slot on both upgrade and extension.
    // An unchanged, previously verified header needs no binary re-download.
    if (verifiedHeader?.equals(header)) { verifiedUntil = now() + 30000; return true; }
    const data = await connection.getAccountInfo(address, { commitment: "confirmed", minContextSlot: context.slot });
    if (!data?.owner.equals(LOADER) || !data.data.subarray(0, 45).equals(header)) throw Error("deployment_changed_during_verification_retry");
    const bytes = data.data.subarray(45);
    if (bytes.length >= binary.length && bytes.subarray(0, binary.length).equals(binary) && bytes.subarray(binary.length).every(b => b === 0)) {
      verifiedHeader = Buffer.from(header); verifiedUntil = now() + 30000; return true;
    }
    if (previous && bytes.length >= previous.bytes && createHash("sha256").update(bytes.subarray(0, previous.bytes)).digest("hex") === previous.sha256
      && bytes.subarray(previous.bytes).every(b => b === 0)) return false;
    throw Error("deployed_binary_or_authority_mismatch");
  }
  return () => {
    if (now() < verifiedUntil) return Promise.resolve(true);
    pending ??= verify().finally(() => { pending = null; });
    return pending;
  };
}
