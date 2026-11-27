import { PublicKey, SystemProgram, VersionedTransaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { CASHIER_MINT, cashierAddresses } from "./claw-cashier-chain.mjs";
import { discriminator } from "./vrf-deployment.mjs";

/** Local backend on 127.0.0.1 by default; CLAW_ADMIN_ORIGIN selects a hosted backend by exact HTTPS origin. */
export function adminTarget(env) {
  if (!env.CLAW_ADMIN_ORIGIN) { const host = `127.0.0.1:${Number(env.CLAW_PORT || 4322)}`; return { origin: `http://${host}`, host }; }
  const url = new URL(env.CLAW_ADMIN_ORIGIN);
  if (url.protocol !== "https:" || url.origin !== env.CLAW_ADMIN_ORIGIN || url.username || url.password) throw Error("invalid_admin_origin");
  return { origin: url.origin, host: url.host };
}

const SYSTEM = SystemProgram.programId, LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const COMPUTE_BUDGET = new PublicKey("ComputeBudget111111111111111111111111111111");
const ATA = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const TRANSFER_CAP = 1_000_000_000, NEW_ACCOUNT_CAP = 10_000_000_000;
// Compute budget: the backend's plans set 1.4M units at price 0 (walletTransaction). Allow a small
// price, and cap the priority fees one CLI run may pay at 0.01 SOL.
const MAX_UNITS = 1_400_000, MAX_UNIT_PRICE = 100_000n, PRIORITY_FEE_CAP = 10_000_000n;
// Rent-exempt lamports per byte (two years at 3,480 lamports per byte-year) and for a 165-byte token account.
const RENT_PER_BYTE = 6_960n, TOKEN_ACCOUNT_RENT = 2_039_280n;
const EXTEND_MIN = 10_240, EXTEND_MAX = 1_048_576;
// Cashier initialisation limits built by initializeCashierInstruction (test USDC base units).
const CASHIER_DAILY_LIMIT = 10_000_000_000n, CASHIER_MAX_CLAIM = 1_000_000_000n;
// Consumer instructions the backend's admin plans build (deployment, sponsor, ER session, pool lanes, cashier).
const PROBE_ADMIN_INSTRUCTIONS = new Set(["initialize_er_pool_session", "update_er_pool_policy", "delegate_er_pool_session",
  "grant_sponsor", "renew_sponsor", "revoke_sponsor", "initialize_er_session", "renew_er_session", "delegate_er_session",
  "request_probe", "initialize_devnet_cashier"].map(name => discriminator(`global:${name}`).toString("hex")));

/** The programs, accounts and sizes the backend's admin plans may touch, from the devnet manifest. */
export function adminPolicy(manifest) {
  const program = new PublicKey(manifest.vrfProbeProgram), cashier = cashierAddresses(manifest);
  // Only programs that appear as top-level instructions in the backend's admin plans. The VRF,
  // delegation and Magic programs are reached by the consumer through CPI; SPL Token is never
  // invoked directly with the admin key, so its instructions (and Token-2022) are refused.
  const programs = [SYSTEM, LOADER, COMPUTE_BUDGET, program, ATA].map(key => key.toBase58());
  return { programs: new Set(programs), program, programData: PublicKey.findProgramAddressSync([program.toBuffer()], LOADER)[0],
    programBytes: Number(manifest.verifiedArtifact?.bytes ?? 0), cashier: cashier.cashier, vault: cashier.vault };
}

// System instructions the backend's plans build while the admin key is involved:
// createAccount (0), transfer (2), advanceNonce (4) and initializeNonce (6). Anything
// else, such as Assign (1) or Allocate (8) of the admin wallet, is refused.
const SYSTEM_KINDS = new Set([0, 2, 4, 6]);

/** Lamports a plan (or a whole CLI run, when shared) may move out of the admin wallet. */
export function adminSpend() { return { transfer: 0n, create: 0n, fee: 0n }; }

function charge(spent, bucket, lamports) {
  spent[bucket] = (spent[bucket] ?? 0n) + lamports;
  if (spent.transfer > BigInt(TRANSFER_CAP) || spent.create > BigInt(NEW_ACCOUNT_CAP)) throw Error("plan_transfer_exceeds_cap");
  if ((spent.fee ?? 0n) > PRIORITY_FEE_CAP) throw Error("plan_priority_fee_exceeds_cap");
}

// Program-data accounts are loader PDAs and so never on the ed25519 curve; the buffers the
// backend creates are keypair accounts. This tells them apart without an RPC read.
const isBuffer = key => !!key && PublicKey.isOnCurve(key.toBytes());

// Upgradeable loader: buffer setup on buffers only; deploy, upgrade and extend only of the
// manifest's program with the admin as authority and payer; nothing that hands over or closes a program.
function checkLoader(data, accounts, admin, policy, spent) {
  if (data.length < 4) throw Error("plan_loader_instruction_not_allowed");
  const kind = data.readUInt32LE(0), is = (index, key) => !!accounts[index]?.equals(key);
  // Deploy lists [payer, programdata, program, ...]; Upgrade and ExtendProgram list [programdata, program, ...].
  const manifestProgram = () => kind === 2 ? is(1, policy.programData) && is(2, policy.program)
    : is(0, policy.programData) && is(1, policy.program);
  switch (kind) {
    case 0: // InitializeBuffer
    case 1: // Write
    case 4: // SetAuthority: only a buffer's (upload authorisation), never a program's
      if (!isBuffer(accounts[0])) throw Error("plan_changes_program_authority");
      return;
    case 2: { // DeployWithMaxDataLen [payer, programdata, program, buffer, rent, clock, system, authority]
      if (data.length !== 12 || !manifestProgram() || !is(0, admin) || !is(7, admin) || !isBuffer(accounts[3])) throw Error("plan_loader_instruction_not_allowed");
      const maxDataLen = data.readBigUInt64LE(4);
      if (!policy.programBytes || maxDataLen < 1n || maxDataLen > BigInt(policy.programBytes)) throw Error("plan_program_size_not_allowed");
      return;
    }
    case 3: // Upgrade [programdata, program, buffer, spill, rent, clock, authority]
      if (data.length !== 4 || !manifestProgram() || !is(3, admin) || !is(6, admin) || !isBuffer(accounts[2])) throw Error("plan_loader_instruction_not_allowed");
      return;
    case 6: { // ExtendProgram [programdata, program, system, payer]
      if (data.length !== 8 || !manifestProgram() || !is(3, admin)) throw Error("plan_loader_instruction_not_allowed");
      const bytes = data.readUInt32LE(4), limit = Math.min(EXTEND_MAX, Math.ceil(policy.programBytes / EXTEND_MIN) * EXTEND_MIN);
      if (bytes < EXTEND_MIN || bytes > limit) throw Error("plan_program_size_not_allowed");
      // The admin pays the added rent; it counts toward the new-account cap like the buffer itself.
      charge(spent, "create", BigInt(bytes) * RENT_PER_BYTE);
      return;
    }
    // Close (5), SetAuthorityChecked (7), Migrate (8) and anything newer are never built by the backend.
    case 5: case 7: case 8: throw Error("plan_changes_program_authority");
    default: throw Error("plan_loader_instruction_not_allowed");
  }
}

// Checks one compiled instruction against the policy; throws before anything is signed.
function checkInstruction(ix, keys, admin, policy, spent) {
  const programId = keys[ix.programIdIndex], accounts = ix.accountKeyIndexes.map(index => keys[index]), data = Buffer.from(ix.data);
  if (!policy.programs.has(programId.toBase58())) throw Error("plan_program_not_allowed");
  if (programId.equals(SYSTEM)) {
    if (!accounts.some(key => key.equals(admin))) return;
    const kind = data.length >= 4 ? data.readUInt32LE(0) : -1;
    if (kind === 3 || kind === 11) throw Error("plan_transfer_exceeds_cap"); // seeded variants are not used by the backend
    if (!SYSTEM_KINDS.has(kind)) throw Error("plan_system_instruction_not_allowed");
    if ((kind === 0 || kind === 2) && accounts[0]?.equals(admin)) {
      if (data.length < 12) throw Error("plan_system_instruction_not_allowed");
      // Caps apply to the running total, so many small transfers cannot add up past them.
      charge(spent, kind === 2 ? "transfer" : "create", data.readBigUInt64LE(4));
    }
    return;
  }
  if (programId.equals(LOADER)) return checkLoader(data, accounts, admin, policy, spent);
  if (programId.equals(COMPUTE_BUDGET)) return; // checked per transaction in checkComputeBudget
  if (programId.equals(ATA)) {
    // Only the cashier plan's idempotent creation of the vault ATA (admin pays rent), with classic SPL Token.
    if (!(data.length === 0 || (data.length === 1 && data[0] <= 1)) || accounts.length !== 6 || !accounts[0].equals(admin)
      || !accounts[1].equals(policy.vault) || !accounts[2].equals(policy.cashier) || !accounts[3].equals(CASHIER_MINT)
      || !accounts[4].equals(SYSTEM) || !accounts[5].equals(TOKEN_PROGRAM_ID)) throw Error("plan_token_instruction_not_allowed");
    return charge(spent, "create", TOKEN_ACCOUNT_RENT);
  }
  // The manifest's consumer program: only the instructions the backend's admin plans build.
  if (data.length < 8 || !PROBE_ADMIN_INSTRUCTIONS.has(data.subarray(0, 8).toString("hex"))) throw Error("plan_program_instruction_not_allowed");
  if (data.subarray(0, 8).equals(discriminator("global:initialize_devnet_cashier"))
    && (data.length !== 56 || data.readBigUInt64LE(40) > CASHIER_DAILY_LIMIT || data.readBigUInt64LE(48) > CASHIER_MAX_CLAIM))
    throw Error("plan_program_instruction_not_allowed");
}

// Compute-budget instructions: unit limit and price only, each at most once, with a bounded price
// and the resulting priority fee counted toward the run's fee cap.
function checkComputeBudget(tx, spent) {
  const keys = tx.message.staticAccountKeys;
  let units = null, price = null;
  for (const ix of tx.message.compiledInstructions) {
    if (!keys[ix.programIdIndex].equals(COMPUTE_BUDGET)) continue;
    const data = Buffer.from(ix.data);
    if (data[0] === 2 && data.length === 5 && units === null) units = data.readUInt32LE(1);
    else if (data[0] === 3 && data.length === 9 && price === null) price = data.readBigUInt64LE(1);
    else throw Error("plan_compute_budget_not_allowed");
  }
  if (units !== null && units > MAX_UNITS) throw Error("plan_compute_budget_not_allowed");
  if (price === null) return;
  if (price > MAX_UNIT_PRICE) throw Error("plan_priority_fee_exceeds_cap");
  charge(spent, "fee", (price * BigInt(units ?? MAX_UNITS) + 999_999n) / 1_000_000n);
}

// Signs one admin plan from the claw backend with a devnet key file, in place of the
// Phantom dashboard. Every check runs before anything is signed.
// Not checked here, because the CLI has no RPC connection of its own: that an Upgrade's
// buffer holds the manifest's verified bytes. Only the backend checks that today.
export function signPlan(plan, keypair, policy, spent = adminSpend()) {
  if (!policy?.programs || !policy.programData || !policy.program) throw Error("admin_policy_required");
  if (plan?.cluster !== "devnet") throw Error("plan_not_devnet");
  if (plan.authority !== keypair.publicKey.toBase58()) throw Error("plan_authority_mismatch");
  if (!Array.isArray(plan.transactions) || !plan.transactions.length) throw Error("plan_has_no_transactions");
  const transactions = plan.transactions.map(value => VersionedTransaction.deserialize(Buffer.from(value, "base64")));
  // Count against a copy, so a refused plan does not use up the caller's budget.
  const total = { ...adminSpend(), ...spent };
  for (const tx of transactions) {
    const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
    if (!signers.some(key => key.equals(keypair.publicKey))) throw Error("plan_signer_not_required");
    if (tx.message.addressTableLookups?.length) throw Error("plan_program_not_allowed"); // lookups would hide accounts from the check
    for (const ix of tx.message.compiledInstructions) checkInstruction(ix, tx.message.staticAccountKeys, keypair.publicKey, policy, total);
    checkComputeBudget(tx, total);
  }
  Object.assign(spent, total);
  return transactions.map(tx => { tx.sign([keypair]); return Buffer.from(tx.serialize()).toString("base64"); });
}
