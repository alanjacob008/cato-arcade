import assert from "node:assert/strict";
import { createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { ComputeBudgetProgram, Keypair, PublicKey, SystemProgram, SYSVAR_CLOCK_PUBKEY, SYSVAR_RENT_PUBKEY, TransactionInstruction, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { AuthorityType, TOKEN_2022_PROGRAM_ID, createAssociatedTokenAccountIdempotentInstruction, createSetAuthorityInstruction, createTransferInstruction,
  getAssociatedTokenAddressSync } from "@solana/spl-token";
import { adminPolicy, adminSpend, adminTarget, signPlan } from "./lib/devnet-admin-sign.mjs";
import { CASHIER_MINT, cashierAddresses, initializeCashierInstruction } from "./lib/claw-cashier-chain.mjs";
import { UPLOAD_FUNDING_LAMPORTS, deployProgram, discriminator, durableTransaction, extendProgram, grantSponsor, initializeBuffer, requestProbe,
  revokeSponsor, setBufferAuthority, upgradeProgram, walletTransaction } from "./lib/vrf-deployment.mjs";
import { delegateErSession, initializeErSession } from "./lib/vrf-er.mjs";
import { POOL_POLICY, delegateErPoolSession, initializeErPoolSession } from "./lib/vrf-er-pool.mjs";

// Target: the local backend by default, or an exact HTTPS origin for the hosted one.
assert.deepEqual(adminTarget({}), { origin: "http://127.0.0.1:4322", host: "127.0.0.1:4322" });
assert.deepEqual(adminTarget({ CLAW_PORT: "4400" }), { origin: "http://127.0.0.1:4400", host: "127.0.0.1:4400" });
assert.deepEqual(adminTarget({ CLAW_ADMIN_ORIGIN: "https://claw.example" }), { origin: "https://claw.example", host: "claw.example" });
for (const bad of ["http://claw.example", "https://claw.example/path", "https://u:p@claw.example", "https://claw.example?x=1"])
  assert.throws(() => adminTarget({ CLAW_ADMIN_ORIGIN: bad }), /invalid_admin_origin/);

const admin = Keypair.generate(), other = Keypair.generate(), coSigner = Keypair.generate();
const blockhash = "11111111111111111111111111111111";
const encode = tx => Buffer.from(tx.serialize()).toString("base64");
function transaction(payer, extraSigner) {
  const instructions = [SystemProgram.transfer({ fromPubkey: payer, toPubkey: other.publicKey, lamports: 1 })];
  if (extraSigner) instructions.push(SystemProgram.transfer({ fromPubkey: extraSigner.publicKey, toPubkey: other.publicKey, lamports: 1 }));
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions }).compileToV0Message());
  if (extraSigner) tx.sign([extraSigner]); // the backend pre-signs with its own keys, e.g. the program account on first deploy
  return tx;
}
const programId = Keypair.generate().publicKey;
const policy = adminPolicy({ vrfProbeProgram: programId.toBase58(), vrfProgram: "Vrf1RNUjXmQGjmQrQLvJHs9SNkvDJEsRVFPkfSQUwGz" });
const plan = { id: "p1", cluster: "devnet", authority: admin.publicKey.toBase58(), description: "test", transactions: [encode(transaction(admin.publicKey, coSigner))] };

// Signs each transaction with the admin key and keeps signatures already present.
const signed = signPlan(plan, admin, policy).map(value => VersionedTransaction.deserialize(Buffer.from(value, "base64")));
assert.equal(signed.length, 1);
const message = signed[0].message.serialize();
const keys = signed[0].message.staticAccountKeys;
const ed25519 = publicKey => createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), publicKey.toBuffer()]), format: "der", type: "spki" });
for (const signer of [admin, coSigner]) {
  const index = keys.findIndex(key => key.equals(signer.publicKey));
  assert(verify(null, message, ed25519(signer.publicKey), signed[0].signatures[index]), "signature does not verify");
}

// Refusals: nothing is signed for another cluster, another authority, or a transaction the admin is not asked to sign.
assert.throws(() => signPlan({ ...plan, cluster: "mainnet-beta" }, admin, policy), /plan_not_devnet/);
assert.throws(() => signPlan({ ...plan, authority: other.publicKey.toBase58() }, admin, policy), /plan_authority_mismatch/);
assert.throws(() => signPlan({ ...plan, transactions: [encode(transaction(other.publicKey))] }, admin, policy), /plan_signer_not_required/);
assert.throws(() => signPlan({ ...plan, transactions: [] }, admin, policy), /plan_has_no_transactions/);
// Instruction policy: the backend's "devnet" label is not trusted on its own.
const LOADER = new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111");
const programData = PublicKey.findProgramAddressSync([programId.toBuffer()], LOADER)[0];
const planWith = (...instructions) => ({ ...plan, transactions: [encode(new VersionedTransaction(new TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message()))] });
const loaderIx = (index, target) => new TransactionInstruction({ programId: LOADER, keys: [{ pubkey: target, isSigner: false, isWritable: true },
  { pubkey: admin.publicKey, isSigner: true, isWritable: false }, { pubkey: other.publicKey, isSigner: false, isWritable: false }], data: Buffer.from([index, 0, 0, 0]) });
// Unknown programs are refused.
const foreign = new TransactionInstruction({ programId: Keypair.generate().publicKey, keys: [{ pubkey: admin.publicKey, isSigner: true, isWritable: true }], data: Buffer.alloc(1) });
assert.throws(() => signPlan(planWith(foreign), admin, policy), /plan_program_not_allowed/);
// Moving SOL out of the admin wallet is capped: transfers at 1 SOL, new accounts at 10 SOL.
assert.equal(signPlan(planWith(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: other.publicKey, lamports: 50_000_000 })), admin, policy).length, 1);
assert.throws(() => signPlan(planWith(SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: other.publicKey, lamports: 2_000_000_000 })), admin, policy), /plan_transfer_exceeds_cap/);
assert.throws(() => signPlan(planWith(SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: other.publicKey, lamports: 20_000_000_000, space: 0,
  programId: SystemProgram.programId })), admin, policy), /plan_transfer_exceeds_cap/);
// The program itself cannot be handed to another authority or closed; a buffer can (upload authorisation).
for (const index of [4, 5, 7]) assert.throws(() => signPlan(planWith(loaderIx(index, programData)), admin, policy), /plan_changes_program_authority/);
assert.equal(signPlan(planWith(loaderIx(4, Keypair.generate().publicKey)), admin, policy).length, 1);
// The admin wallet cannot be reassigned or reallocated, and the caps apply to totals:
// many small transfers in one transaction, one plan or one CLI run cannot add up past them.
const sink = Keypair.generate().publicKey, sol = 1_000_000_000;
const pay = lamports => SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: sink, lamports });
assert.throws(() => signPlan(planWith(SystemProgram.assign({ accountPubkey: admin.publicKey, programId: Keypair.generate().publicKey })), admin, policy), /plan_system_instruction_not_allowed/);
assert.throws(() => signPlan(planWith(SystemProgram.allocate({ accountPubkey: admin.publicKey, space: 1 })), admin, policy), /plan_system_instruction_not_allowed/);
assert.throws(() => signPlan(planWith(...Array.from({ length: 10 }, () => pay(sol))), admin, policy), /plan_transfer_exceeds_cap/);
const twoTransactions = { ...plan, transactions: [planWith(pay(0.6 * sol)).transactions[0], planWith(pay(0.6 * sol)).transactions[0]] };
assert.throws(() => signPlan(twoTransactions, admin, policy), /plan_transfer_exceeds_cap/);
const run = adminSpend();
assert.equal(signPlan(planWith(pay(0.6 * sol)), admin, policy, run).length, 1);
assert.throws(() => signPlan(planWith(pay(0.6 * sol)), admin, policy, run), /plan_transfer_exceeds_cap/);
assert.equal(run.transfer, BigInt(0.6 * sol)); // a refused plan does not use up the run's budget
assert.equal(signPlan(planWith(pay(0.3 * sol)), admin, policy, run).length, 1);
// A policy is required.
assert.throws(() => signPlan(plan, admin), /admin_policy_required/);

// ---- Every plan the backend legitimately builds still signs, built with the backend's own builders
// and the same transaction framing as prepare() in vrf-devnet-server.mjs.
const devnet = JSON.parse(readFileSync(new URL("../onchain/deployment.devnet.json", import.meta.url), "utf8"));
const config = { ...devnet, adminAuthority: admin.publicKey.toBase58(), deploymentAuthority: admin.publicKey.toBase58(), vrfProbeProgram: programId.toBase58() };
const strict = adminPolicy(config), bytes = config.verifiedArtifact.bytes;
const nonceAccount = Keypair.generate(), uploadKey = Keypair.generate(), bufferKey = Keypair.generate(), programKey = Keypair.generate();
const delegate = Keypair.generate().publicKey, settlement = Keypair.generate().publicKey;
// prepare(): a durable plan is [nonceAdvance, ...instructions]; walletTransaction adds the fixed compute budget.
const prepared = (instructions, { durable = true, signers = [] } = {}) => ({ ...plan, transactions: [encode(walletTransaction(admin.publicKey, blockhash,
  durable ? durableTransaction(admin.publicKey, nonceAccount.publicKey, blockhash, instructions).instructions : instructions, signers))] });
const rent = size => (size + 128) * 6960;
const legitimate = {
  nonceSetup: prepared(SystemProgram.createNonceAccount({ fromPubkey: admin.publicKey, noncePubkey: nonceAccount.publicKey, authorizedPubkey: admin.publicKey,
    lamports: 1_447_680 }).instructions, { durable: false, signers: [nonceAccount] }),
  uploader: prepared([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: uploadKey.publicKey, lamports: UPLOAD_FUNDING_LAMPORTS }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: bufferKey.publicKey, lamports: rent(37 + bytes), space: 37 + bytes, programId: LOADER }),
    initializeBuffer(bufferKey.publicKey, uploadKey.publicKey)], { durable: false, signers: [bufferKey] }),
  authorizeUpload: prepared([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: uploadKey.publicKey, lamports: 1_000_000 }),
    setBufferAuthority(bufferKey.publicKey, admin.publicKey, uploadKey.publicKey)], { durable: false }),
  extend: prepared([extendProgram(admin.publicKey, programId, 184_320)]),
  upgrade: prepared([upgradeProgram(admin.publicKey, programId, bufferKey.publicKey)]),
  deploy: prepared([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
    SystemProgram.createAccount({ fromPubkey: admin.publicKey, newAccountPubkey: programId, lamports: rent(36), space: 36, programId: LOADER }),
    deployProgram(admin.publicKey, programId, bufferKey.publicKey, bytes)]),
  sponsorGrant: prepared([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: delegate, lamports: 50_000_000 }), grantSponsor(config, delegate, 2e9)]),
  sponsorRenew: prepared([grantSponsor(config, delegate, 2e9, true)]),
  sponsorRevoke: prepared([revokeSponsor(config, delegate)]),
  erSession: prepared([initializeErSession(config, delegate, 2e9)]),
  erRenew: prepared([initializeErSession(config, delegate, 2e9, true)]),
  erDelegate: prepared([delegateErSession(config, delegate)]),
  poolPolicy: prepared([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: delegate, lamports: 5_000_000 }),
    initializeErPoolSession(config, delegate, { ...POOL_POLICY, authorizedUntil: 2e9 })]),
  poolUpdate: prepared([initializeErPoolSession(config, delegate, { ...POOL_POLICY, authorizedUntil: 2e9 }, true)]),
  poolDelegate: prepared([delegateErPoolSession(config, delegate)]),
  cashier: prepared([SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: settlement, lamports: 50_000_000 }), ...initializeCashierInstruction(config, settlement)]),
  probe: prepared([requestProbe(config, "7", 64, 0, "2147483648", Buffer.alloc(32, 7)).instruction]),
};
for (const [name, value] of Object.entries(legitimate)) assert.equal(signPlan(value, admin, strict).length, 1, name);
// A whole upgrade run (nonce, buffer, upload authorisation, extension, upgrade) and a whole first deployment fit the run caps.
const upgradeRun = adminSpend();
for (const name of ["nonceSetup", "uploader", "authorizeUpload", "extend", "upgrade"]) signPlan(legitimate[name], admin, strict, upgradeRun);
const deployRun = adminSpend();
for (const name of ["nonceSetup", "uploader", "authorizeUpload", "deploy", "cashier"]) signPlan(legitimate[name], admin, strict, deployRun);
// The default compute budget the backend adds (price 0) costs no priority fee.
assert.equal(upgradeRun.fee, 0n);

// ---- Hostile plans from a backend that controls the plan responses: nothing below is signed.
const attacker = Keypair.generate();
const raw = (programIdKey, keys, data) => new TransactionInstruction({ programId: programIdKey, keys: keys.map(([pubkey, isWritable, isSigner]) => ({ pubkey, isWritable: !!isWritable, isSigner: !!isSigner })), data });
const loaderData = (kind, extra = Buffer.alloc(0)) => Buffer.concat([Buffer.from([kind, 0, 0, 0]), extra]);
const u32 = n => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; }, u64 = n => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const refuse = (instructions, pattern, options) => assert.throws(() => signPlan(prepared(instructions, options), admin, strict), pattern);
const otherProgram = Keypair.generate().publicKey, otherProgramData = PublicKey.findProgramAddressSync([otherProgram.toBuffer()], LOADER)[0];
const sponsorshipProgram = new PublicKey(JSON.parse(readFileSync(new URL("../onchain/sponsorship.devnet.json", import.meta.url), "utf8")).program);
const sponsorshipProgramData = PublicKey.findProgramAddressSync([sponsorshipProgram.toBuffer()], LOADER)[0];
// Upgrade: only the manifest program, with the admin as authority and as spill (buffer rent) recipient.
refuse([upgradeProgram(admin.publicKey, otherProgram, bufferKey.publicKey)], /plan_loader_instruction_not_allowed/);
refuse([raw(LOADER, [[programData, 1], [programId, 1], [bufferKey.publicKey, 1], [attacker.publicKey, 1], [SYSVAR_RENT_PUBKEY], [SYSVAR_CLOCK_PUBKEY], [admin.publicKey, 0, 1]], loaderData(3))], /plan_loader_instruction_not_allowed/);
refuse([raw(LOADER, [[programData, 1], [programId, 1], [programData, 1], [admin.publicKey, 1], [SYSVAR_RENT_PUBKEY], [SYSVAR_CLOCK_PUBKEY], [admin.publicKey, 0, 1]], loaderData(3))], /plan_loader_instruction_not_allowed/);
// ExtendProgram by 10 MiB, of another program, or repeated until the rent passes the new-account cap.
refuse([raw(LOADER, [[programData, 1], [programId, 1], [SystemProgram.programId], [admin.publicKey, 1, 1]], loaderData(6, u32(10_485_760)))], /plan_program_size_not_allowed/);
refuse([raw(LOADER, [[programData, 1], [programId, 1], [SystemProgram.programId], [admin.publicKey, 1, 1]], loaderData(6, u32(1_048_576)))], /plan_program_size_not_allowed/);
refuse([extendProgram(admin.publicKey, sponsorshipProgram, 10_240)], /plan_loader_instruction_not_allowed/);
const extendRun = adminSpend();
assert.throws(() => { for (let i = 0; i < 20; i++) signPlan(prepared([extendProgram(admin.publicKey, programId, 614_400)]), admin, strict, extendRun); }, /plan_transfer_exceeds_cap/);
// DeployWithMaxDataLen of 10 MiB, with an attacker upgrade authority, or of another program.
refuse([deployProgram(admin.publicKey, programId, bufferKey.publicKey, 10_485_760)], /plan_program_size_not_allowed/);
const hostileDeploy = deployProgram(admin.publicKey, programId, bufferKey.publicKey, bytes);
hostileDeploy.keys[7] = { pubkey: attacker.publicKey, isWritable: false, isSigner: true };
assert.throws(() => signPlan({ ...plan, transactions: [encode(walletTransaction(admin.publicKey, blockhash, [hostileDeploy], [attacker]))] }, admin, strict), /plan_loader_instruction_not_allowed/);
refuse([deployProgram(admin.publicKey, otherProgram, bufferKey.publicKey, 1000)], /plan_loader_instruction_not_allowed/);
// SetAuthority, SetAuthorityChecked, Close and Migrate on any program data, including another program sharing the admin key;
// Close of a buffer and unknown loader instructions are not built either.
for (const target of [otherProgramData, sponsorshipProgramData, programData]) {
  refuse([raw(LOADER, [[target, 1], [admin.publicKey, 0, 1], [attacker.publicKey]], loaderData(4))], /plan_changes_program_authority/);
  refuse([raw(LOADER, [[target, 1], [admin.publicKey, 0, 1], [attacker.publicKey, 0, 1]], loaderData(7))], /plan_changes_program_authority/);
  refuse([raw(LOADER, [[target, 1], [attacker.publicKey, 1], [admin.publicKey, 0, 1]], loaderData(8))], /plan_changes_program_authority/);
}
refuse([raw(LOADER, [[bufferKey.publicKey, 1], [attacker.publicKey, 1], [admin.publicKey, 0, 1]], loaderData(5))], /plan_changes_program_authority/);
refuse([raw(LOADER, [[otherProgramData, 1], [admin.publicKey, 0, 1]], loaderData(0))], /plan_changes_program_authority/);
refuse([raw(LOADER, [[programData, 1], [admin.publicKey, 0, 1]], loaderData(9))], /plan_loader_instruction_not_allowed/);
// Compute budget: an unbounded priority fee, more than 1.4M units, heap frames, and fees adding up across a run.
refuse([ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000_000_000 }), pay(1)], /plan_priority_fee_exceeds_cap/);
assert.throws(() => signPlan(planWith(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_001 }), pay(1)), admin, strict), /plan_compute_budget_not_allowed/);
assert.throws(() => signPlan(planWith(ComputeBudgetProgram.requestHeapFrame({ bytes: 262_144 }), pay(1)), admin, strict), /plan_compute_budget_not_allowed/);
const feeRun = adminSpend(), pricey = planWith(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }), pay(1));
assert.equal(signPlan(pricey, admin, strict, feeRun).length, 1);
assert.equal(feeRun.fee, 140_000n);
assert.throws(() => { for (let i = 0; i < 100; i++) signPlan(pricey, admin, strict, feeRun); }, /plan_priority_fee_exceeds_cap/);
// SPL Token and Token-2022 instructions with the admin as authority: transfer and account-owner change.
const adminToken = getAssociatedTokenAddressSync(CASHIER_MINT, admin.publicKey);
refuse([createTransferInstruction(adminToken, attacker.publicKey, admin.publicKey, 10n ** 15n)], /plan_program_not_allowed/);
refuse([createSetAuthorityInstruction(adminToken, admin.publicKey, AuthorityType.AccountOwner, attacker.publicKey)], /plan_program_not_allowed/);
refuse([createTransferInstruction(adminToken, attacker.publicKey, admin.publicKey, 1n, [], TOKEN_2022_PROGRAM_ID)], /plan_program_not_allowed/);
// ATA creation only for the cashier vault, with classic SPL Token; not for another owner or mint, nor via Token-2022 or RecoverNested.
refuse([createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, getAssociatedTokenAddressSync(CASHIER_MINT, attacker.publicKey), attacker.publicKey, CASHIER_MINT)], /plan_token_instruction_not_allowed/);
const otherMint = Keypair.generate().publicKey, cashierPda = cashierAddresses(config).cashier;
refuse([createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, getAssociatedTokenAddressSync(otherMint, cashierPda, true), cashierPda, otherMint)], /plan_token_instruction_not_allowed/);
refuse([createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, getAssociatedTokenAddressSync(CASHIER_MINT, cashierPda, true, TOKEN_2022_PROGRAM_ID), cashierPda, CASHIER_MINT, TOKEN_2022_PROGRAM_ID)], /plan_token_instruction_not_allowed/);
const nested = createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, cashierAddresses(config).vault, cashierPda, CASHIER_MINT); nested.data = Buffer.from([2]);
refuse([nested], /plan_token_instruction_not_allowed/);
// VRF, delegation and Magic programs are reached only by CPI, never as admin-signed top-level instructions.
for (const key of [config.vrfProgram, "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh", "Magic11111111111111111111111111111111111111"])
  refuse([raw(new PublicKey(key), [[admin.publicKey, 1, 1]], Buffer.alloc(8))], /plan_program_not_allowed/);
// Consumer instructions the backend never asks the admin to sign (e.g. pausing the cashier), and a cashier with larger limits.
refuse([raw(programId, [[admin.publicKey, 0, 1], [cashierPda, 1]], Buffer.concat([discriminator("global:pause_devnet_cashier"), Buffer.from([0])]))], /plan_program_instruction_not_allowed/);
refuse([raw(programId, [[admin.publicKey, 1, 1]], Buffer.alloc(4))], /plan_program_instruction_not_allowed/);
const greedy = initializeCashierInstruction(config, attacker.publicKey)[1]; u64(10n ** 15n).copy(greedy.data, 48);
refuse([greedy], /plan_program_instruction_not_allowed/);
// A deploy or extension needs the manifest's verified size; a policy without one refuses both.
const unsized = adminPolicy({ ...config, verifiedArtifact: undefined });
assert.throws(() => signPlan(legitimate.deploy, admin, unsized), /plan_program_size_not_allowed/);
assert.throws(() => signPlan(legitimate.extend, admin, unsized), /plan_program_size_not_allowed/);
console.log("PASS: devnet admin signer signs only devnet plans for its own authority and keeps backend co-signatures.");
console.log("PASS: every backend admin plan shape still signs; hostile loader, compute-budget, token, ATA and consumer instructions are refused.");
