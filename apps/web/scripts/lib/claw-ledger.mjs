import { DatabaseSync } from "node:sqlite";
import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { LOGIN_PRUNE_INTERVAL_MS, WALLET_SESSION_LIMIT, createChallengeNonces } from "./claw-login.mjs";

const hash = value => createHash("sha256").update(value).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));
const MAX_CENTS = 1_000_000_000_000;
function exact(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw Error("invalid_player_request");
}
const requestId = id => { if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw Error("invalid_request_id"); return id; };

// This ledger is explicitly devnet-only. No public purchase/withdrawal mutation
// exists, and no browser/demo storage is imported into it.
export function createClawLedger({ filename, origin, rules, physics, game, available, now = Date.now, challengeKey }) {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin)) throw Error("invalid_ledger_origin");
  const nonces = createChallengeNonces(`${origin}\ndevnet-test-v1`, challengeKey); let pruned = -Infinity;
  const challengeMessage = (wallet,nonce,issued,expires) => `CATO Arcade wallet sign-in\nOrigin: ${origin}\nCluster: devnet\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${issued}\nExpires: ${expires}\nThis signature authorizes this browser session only. No transaction or fund transfer.`;
  // The stored proof id is scoped to the wallet, so knowing another wallet's nonce cannot consume it.
  const parseProof = body => {
    const match = typeof body.id==="string" && /^([a-f0-9]{64})\.([1-9][0-9]{0,14})$/.exec(body.id);
    if (!match || typeof body.wallet!=="string" || typeof body.signature!=="string" || !/^[a-f0-9]{128}$/.test(body.signature)) return null;
    try { if (new PublicKey(body.wallet).toBase58()!==body.wallet) return null; } catch { return null; }
    const issued=Number(match[2]);return {nonce:match[1],issued,expires:issued+60_000,id:hash(`${body.wallet}:${match[1]}`)};
  };
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS challenges (id TEXT PRIMARY KEY, wallet TEXT NOT NULL, message TEXT NOT NULL, expires INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, wallet TEXT NOT NULL, expires INTEGER NOT NULL, start_entry INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS players (wallet TEXT PRIMARY KEY, state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, wallet TEXT NOT NULL REFERENCES players(wallet), request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, pull TEXT NOT NULL, result TEXT, error TEXT, UNIQUE(wallet, request_id));
    CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, wallet TEXT NOT NULL REFERENCES players(wallet), kind TEXT NOT NULL, tier INTEGER, quantity INTEGER NOT NULL DEFAULT 0, cents INTEGER NOT NULL DEFAULT 0 CHECK(cents>=0 AND cents<=1000000000000), created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS faucets (wallet TEXT NOT NULL, day TEXT NOT NULL, quantity INTEGER NOT NULL, PRIMARY KEY(wallet,day));`);
  if(!db.prepare("PRAGMA table_info(sessions)").all().some(column=>column.name==="start_entry")) db.exec("ALTER TABLE sessions ADD COLUMN start_entry INTEGER NOT NULL DEFAULT 0");
  db.prepare("INSERT OR IGNORE INTO metadata VALUES ('namespace','devnet-test-v1')").run();
  if (db.prepare("SELECT value FROM metadata WHERE key='namespace'").get().value !== "devnet-test-v1") throw Error("ledger_namespace_mismatch");
  const transaction = fn => { db.exec("BEGIN IMMEDIATE"); try { const result = fn(); db.exec("COMMIT"); return result; } catch (error) { db.exec("ROLLBACK"); throw error; } };
  const read = wallet => { const row = db.prepare("SELECT state FROM players WHERE wallet=?").get(wallet); if (!row) throw Error("player_not_initialized"); return JSON.parse(row.state); };
  const write = (wallet, state) => db.prepare("UPDATE players SET state=? WHERE wallet=?").run(JSON.stringify(state), wallet);
  const attempt = (wallet, id) => db.prepare("SELECT * FROM attempts WHERE id=? AND wallet=?").get(id, wallet);
  const jobs = new Map(), creations = new Map(), settlements = new Map(); let dispatchQueue = Promise.resolve();
  function publicState(wallet) {
    const state = read(wallet), pending = state.pendingId ? attempt(wallet, state.pendingId) : null;
    return { ...state, namespace: "devnet-test-v1", wallet, withdrawableCents: 0, paymentsEnabled: false,
      pending: pending ? { id: pending.id, pull: JSON.parse(pending.pull), error: pending.error } : null };
  }
  async function ensurePlayer(wallet) {
    if (db.prepare("SELECT 1 FROM players WHERE wallet=?").get(wallet)) return;
    if (!creations.has(wallet)) creations.set(wallet, (async () => {
      const arrangement = rules.dailyArrangement(`ledger-devnet:${wallet}`, now()), boxes = await physics.create(arrangement.seed, { newWallet: true });
      transaction(() => {
        const added = db.prepare("INSERT OR IGNORE INTO players VALUES (?,?)").run(wallet, JSON.stringify({ revision: 0, arrangement, initialBoxes: boxes, boxes, balances: [10,10,10], winningsCents: 0, pendingId: null, history: [] }));
        if (added.changes) for (let tier=0;tier<3;tier++) db.prepare("INSERT INTO entries VALUES (?,?,?,?,?,?,?)").run(`initial:${wallet}:${tier}`,wallet,"test-credit",tier,10,0,now());
      });
    })().finally(() => creations.delete(wallet)));
    await creations.get(wallet);
  }
  async function rotate(wallet) {
    const current = read(wallet), arrangement = rules.dailyArrangement(`ledger-devnet:${wallet}`, now());
    if (current.pendingId || current.arrangement.id === arrangement.id) return;
    const boxes = await physics.create(arrangement.seed);
    transaction(() => { const state=read(wallet); if (state.pendingId || state.arrangement.id === arrangement.id) return;
      state.arrangement=arrangement;state.initialBoxes=boxes;state.boxes=boxes;state.revision++;write(wallet,state); });
  }
  function settle(wallet, row, receipt) {
    if (!settlements.has(row.id)) settlements.set(row.id, doSettle(wallet,row,receipt).finally(()=>settlements.delete(row.id)));
    return settlements.get(row.id);
  }
  async function doSettle(wallet, row, receipt) {
    row=attempt(wallet,row.id);
    if (row.result) return JSON.parse(row.result);
    const pull=JSON.parse(row.pull), outcome=receipt.result;
    if (!outcome || receipt.gameId!==row.id || (pull.target && (!receipt.callbackSignature || !receipt.requestSignature))) throw Error("verified_result_required");
    const expected=rules.resolvePull(pull,()=>outcome.roll,"magicblock-vrf");
    if (JSON.stringify(expected)!==JSON.stringify(outcome)) throw Error("ledger_result_mismatch");
    const before=read(wallet);
    if (before.pendingId!==row.id || before.arrangement.id!==pull.arrangement.id) throw Error("ledger_pending_mismatch");
    const remaining=outcome.success ? before.boxes.filter(box=>box.id!==outcome.targetId) : before.boxes;
    if (outcome.success && remaining.length!==before.boxes.length-1) throw Error("prize_already_removed");
    const boxes=outcome.success ? await physics.settle(remaining) : remaining;
    return transaction(()=>{
      const locked=attempt(wallet,row.id); if (locked.result) return JSON.parse(locked.result);
      const state=read(wallet); if (state.pendingId!==row.id || state.winningsCents+outcome.cents>MAX_CENTS) throw Error("ledger_settlement_blocked");
      db.prepare("INSERT INTO entries VALUES (?,?,?,?,?,?,?)").run(`result:${row.id}`,wallet,"result",pull.tier,0,outcome.cents,now());
      state.winningsCents+=outcome.cents;state.boxes=boxes;state.pendingId=null;state.revision++;
      state.history=[{id:row.id,tier:pull.tier,entryCents:pull.priceUsd*100,result:outcome,requestSignature:receipt.requestSignature??null,callbackSignature:receipt.callbackSignature??null},...state.history].slice(0,100);
      write(wallet,state);db.prepare("UPDATE attempts SET result=?,error=NULL WHERE id=?").run(JSON.stringify(outcome),row.id);return outcome;
    });
  }
  function start(wallet,id) {
    if (jobs.has(id)) return jobs.get(id);
    // A pool leases independent nonce streams. The legacy diagnostic service
    // still needs serialized preparation; neither path changes locked pulls.
    const work=(game.concurrent?Promise.resolve():dispatchQueue.catch(()=>{})).then(async()=>{
      let row=attempt(wallet,id); if (!row) throw Error("attempt_not_found"); if (row.result) return;
      const pull=JSON.parse(row.pull);
      let receipt=pull.target ? await game.plan(pull) : {gameId:id,result:rules.resolvePull(pull,()=>{throw Error("unexpected_draw");},"magicblock-vrf")};
      if (receipt.result) await settle(wallet,row,receipt);
      db.prepare("UPDATE attempts SET error=NULL WHERE id=?").run(id);
    }).catch(error=>{ db.prepare("UPDATE attempts SET error=? WHERE id=? AND result IS NULL").run(/^[a-z_]+$/.test(error.message)?error.message:"attempt_pending_retry",id); })
      .finally(()=>jobs.delete(id));
    jobs.set(id,work);if(!game.concurrent)dispatchQueue=work;return work;
  }
  async function reconcile(wallet,id) {
    const row=attempt(wallet,id);if (!row) throw Error("attempt_not_found");
    if (row.result) return JSON.parse(row.result);
    if (jobs.has(id)) return null;
    const pull=JSON.parse(row.pull);
    const receipt=pull.target ? await game.state(id) : {gameId:id,result:rules.resolvePull(pull,()=>{throw Error("unexpected_draw");},"magicblock-vrf")};
    if (receipt.result) return settle(wallet,row,receipt);
    return null;
  }
  return {
    // Issuance is stateless: anonymous callers cannot fill a shared quota and lock other
    // wallets out of sign-in. The id carries the nonce and issue time; login checks the
    // nonce's server MAC, rebuilds the exact message from server configuration and records each proof once.
    challenge(wallet) {
      if (typeof wallet!=="string" || new PublicKey(wallet).toBase58()!==wallet) throw Error("invalid_wallet");
      const issued=now(),nonce=nonces.issue(wallet,issued),expires=issued+60_000;
      return {id:`${nonce}.${issued}`,message:challengeMessage(wallet,nonce,issued,expires),expires};
    },
    async login(body) {
      exact(body,["id","wallet","signature"]);
      const proof=parseProof(body);if (!proof) throw Error("invalid_wallet_proof");
      const {nonce,issued,expires}=proof;
      // Time bound, issuance MAC and signature are checked before any database or physics work.
      if (issued>now() || expires<=now() || !nonces.valid(body.wallet,nonce,issued)) throw Error("invalid_wallet_proof");
      const key=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),new PublicKey(body.wallet).toBuffer()]),format:"der",type:"spki"});
      const message=challengeMessage(body.wallet,nonce,issued,expires);
      if (!verify(null,Buffer.from(message),key,Buffer.from(body.signature,"hex"))) throw Error("invalid_wallet_proof");
      if (db.prepare("SELECT 1 FROM challenges WHERE id=?").get(proof.id)) throw Error("invalid_wallet_proof");
      // A new wallet's pile is created before the proof is consumed, so a busy retry can reuse the same signature.
      await ensurePlayer(body.wallet);
      const token=randomBytes(32).toString("hex"),sessionExpires=now()+12*3600_000;
      transaction(()=>{
        const changed=db.prepare("INSERT OR IGNORE INTO challenges (id,wallet,message,expires,used) VALUES (?,?,?,?,1)").run(proof.id,body.wallet,message,expires);if (!changed.changes) throw Error("wallet_proof_already_used");
        const baseline=db.prepare("SELECT COALESCE(MAX(rowid),0) AS n FROM entries WHERE wallet=?").get(body.wallet).n,tokenHash=hash(token);
        db.prepare("INSERT INTO sessions (hash,wallet,expires,start_entry) VALUES (?,?,?,?)").run(tokenHash,body.wallet,sessionExpires,baseline);
        // Keep this session and the wallet's newest others, up to the per-wallet limit.
        db.prepare("DELETE FROM sessions WHERE wallet=? AND hash<>? AND hash NOT IN (SELECT hash FROM sessions WHERE wallet=? AND hash<>? ORDER BY expires DESC, rowid DESC LIMIT ?)")
          .run(body.wallet,tokenHash,body.wallet,tokenHash,WALLET_SESSION_LIMIT-1);});
      return {token,expires:sessionExpires,state:publicState(body.wallet)};
    },
    // Revokes only the presenting session. Balances, inventory and any pending attempt stay with the wallet.
    logout(token) {
      if (typeof token!=="string" || !/^[a-f0-9]{64}$/.test(token)) throw Error("player_authentication_required");
      if (!db.prepare("DELETE FROM sessions WHERE hash=?").run(hash(token)).changes) throw Error("player_authentication_required");
      return {ok:true};
    },
    authenticate(token) {
      if (typeof token!=="string" || !/^[a-f0-9]{64}$/.test(token)) throw Error("player_authentication_required");
      const row=db.prepare("SELECT wallet FROM sessions WHERE hash=? AND expires>?").get(hash(token),now());if (!row) throw Error("player_authentication_required");return row.wallet;
    },
    sessionWinnings(token) {
      const wallet=this.authenticate(token),session=db.prepare("SELECT start_entry FROM sessions WHERE hash=?").get(hash(token));
      return db.prepare("SELECT COALESCE(SUM(cents),0) AS cents FROM entries WHERE wallet=? AND kind='result' AND rowid>?").get(wallet,session.start_entry).cents;
    },
    async state(wallet) {await rotate(wallet);const state=read(wallet);if (state.pendingId) await reconcile(wallet,state.pendingId);return publicState(wallet);},
    async play(wallet,intent) {
      exact(intent,["requestId","revision","aim","tier"]);requestId(intent.requestId);exact(intent.aim,["x","z"]);
      if (!Number.isSafeInteger(intent.revision)||intent.revision<0||!Number.isInteger(intent.tier)||intent.tier<0||intent.tier>2||![intent.aim.x,intent.aim.z].every(Number.isFinite)) throw Error("invalid_play_intent");
      const fingerprint=hash(JSON.stringify([intent.revision,intent.tier,intent.aim.x,intent.aim.z]));
      const prior=db.prepare("SELECT * FROM attempts WHERE wallet=? AND request_id=?").get(wallet,intent.requestId);
      if (prior) {if (prior.fingerprint!==fingerprint) throw Error("request_inputs_changed");start(wallet,prior.id);return {id:prior.id,pull:JSON.parse(prior.pull),state:publicState(wallet)};}
      await rotate(wallet);const ready=await available();if (!ready) throw Error("sponsor_setup_required");
      const row=transaction(()=>{
        const existing=db.prepare("SELECT * FROM attempts WHERE wallet=? AND request_id=?").get(wallet,intent.requestId);
        if(existing){if(existing.fingerprint!==fingerprint)throw Error("request_inputs_changed");return {id:existing.id,pull:JSON.parse(existing.pull)};}
        const state=read(wallet);if (state.pendingId) throw Error("player_attempt_pending");if (state.revision!==intent.revision) throw Error("stale_player_state");if (!state.boxes.length) throw Error("machine_empty");if (!state.balances[intent.tier]) throw Error("insufficient_tokens");
        const id=randomUUID(),target=rules.selectTarget(intent.aim,state.boxes,intent.tier,{},"USDC");
        const pull={id,rulesVersion:rules.RULES_VERSION,aim:copy(intent.aim),target,tier:intent.tier,currency:"USDC",priceUsd:rules.entryPriceUsd(intent.tier,"USDC"),arrangement:state.arrangement};
        db.prepare("INSERT INTO attempts (id,wallet,request_id,fingerprint,pull) VALUES (?,?,?,?,?)").run(id,wallet,intent.requestId,fingerprint,JSON.stringify(pull));
        db.prepare("INSERT INTO entries VALUES (?,?,?,?,?,?,?)").run(`reserve:${id}`,wallet,"token-debit",intent.tier,-1,0,now());state.balances[intent.tier]--;state.pendingId=id;state.revision++;write(wallet,state);return {id,pull};
      });start(wallet,row.id);return {...row,state:publicState(wallet)};
    },
    async result(wallet,id,resume=false) {
      requestId(id);const row=attempt(wallet,id);if (!row) throw Error("attempt_not_found");
      if (resume && !row.result) start(wallet,id);
      const result=await reconcile(wallet,id);return {id,pull:JSON.parse(row.pull),result,state:publicState(wallet)};
    },
    creditTest(wallet,body) {
      exact(body,["requestId","tier","quantity"]);requestId(body.requestId);
      if (!Number.isInteger(body.tier)||body.tier<0||body.tier>2||!Number.isInteger(body.quantity)||body.quantity<1||body.quantity>100) throw Error("invalid_test_credit");
      const id=`faucet:${wallet}:${body.requestId}`,day=new Date(now()).toISOString().slice(0,10);
      return transaction(()=>{
        const prior=db.prepare("SELECT tier,quantity FROM entries WHERE id=?").get(id);
        if (prior) {if (prior.tier!==body.tier||prior.quantity!==body.quantity) throw Error("request_inputs_changed");return publicState(wallet);}
        const state=read(wallet);if (state.pendingId) throw Error("player_attempt_pending");
        const used=db.prepare("SELECT quantity FROM faucets WHERE wallet=? AND day=?").get(wallet,day)?.quantity??0;
        if (used+body.quantity>100) throw Error("daily_test_credit_limit_reached");
        db.prepare("INSERT INTO faucets VALUES (?,?,?) ON CONFLICT(wallet,day) DO UPDATE SET quantity=excluded.quantity").run(wallet,day,used+body.quantity);
        db.prepare("INSERT INTO entries VALUES (?,?,?,?,?,?,?)").run(id,wallet,"test-credit",body.tier,body.quantity,0,now());state.balances[body.tier]+=body.quantity;state.revision++;write(wallet,state);return publicState(wallet);
      });
    },
    async idle() {await Promise.all(jobs.values());},
    async tick() {
      // Expired rows are already refused; pruning them is bounded housekeeping, not a sign-in step.
      if (now()-pruned>=LOGIN_PRUNE_INTERVAL_MS) { pruned=now();
        try { db.prepare("DELETE FROM challenges WHERE expires<?").run(now()); db.prepare("DELETE FROM sessions WHERE expires<?").run(now()); } catch { /* Retried on a later tick. */ } }
      const rows=db.prepare("SELECT id,wallet FROM attempts WHERE result IS NULL LIMIT 20").all();
      const width=game.concurrent?4:1;
      for(let i=0;i<rows.length;i+=width)await Promise.all(rows.slice(i,i+width).map(async row=>{
        try {const result=await reconcile(row.wallet,row.id);if(!result&&!jobs.has(row.id))start(row.wallet,row.id);} catch { /* Keep the same reserved draw. */ }
      }));
    },
    close() {db.close();},
  };
}
