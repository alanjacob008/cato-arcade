import { createHash, createPublicKey, randomBytes, randomUUID, verify } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { CLAW_SCHEMA } from "./claw-postgres.mjs";
import { LOGIN_PRUNE_INTERVAL_MS, WALLET_SESSION_LIMIT, createChallengeNonces } from "./claw-login.mjs";

const hash = value => createHash("sha256").update(value).digest("hex"), copy = value => structuredClone(value);
const MAX_CENTS = 1_000_000_000_000;
export function exactRequest(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) throw Error("invalid_player_request");
}
const identifier = id => { if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw Error("invalid_request_id"); return id; };
const cents = value => { const number = Number(value); if (!Number.isSafeInteger(number) || number < 0 || number > MAX_CENTS) throw Error("invalid_ledger_amount"); return number; };

/** Hosted ledger. Paid-devnet tables are namespaced and never import demo state. */
export async function createPgClawLedger({ store, origin, rules, physics, game, available, paymentsEnabled = false, now = Date.now, challengeKey }) {
  const parsed = new URL(origin);
  if (parsed.origin !== origin || parsed.username || parsed.password
    || !(parsed.protocol === "https:" || parsed.protocol === "http:" && parsed.hostname === "127.0.0.1")) throw Error("invalid_ledger_origin");
  const ns = paymentsEnabled ? "devnet-usdc-v1" : "devnet-test-pg-v1";
  const nonces = createChallengeNonces(`${origin}\n${ns}`, challengeKey); let pruned = -Infinity;
  const challengeMessage = (wallet,nonce,issued,expires) => `CATO Arcade wallet sign-in\nOrigin: ${origin}\nCluster: devnet\nNamespace: ${ns}\nWallet: ${wallet}\nNonce: ${nonce}\nIssued: ${issued}\nExpires: ${expires}\nThis signature authorizes this browser session only. No transaction or fund transfer.`;
  // The stored proof id is scoped to the wallet, so knowing another wallet's nonce cannot consume it.
  const parseProof = body => {
    const match = typeof body.id==="string" && /^([a-f0-9]{64})\.([1-9][0-9]{0,14})$/.exec(body.id);
    if (!match || typeof body.wallet!=="string" || typeof body.signature!=="string" || !/^[a-f0-9]{128}$/.test(body.signature)) return null;
    try { if (new PublicKey(body.wallet).toBase58()!==body.wallet) return null; } catch { return null; }
    const issued=Number(match[2]);return {nonce:match[1],issued,expires:issued+60000,id:hash(`${body.wallet}:${match[1]}`)};
  };
  await store.transaction(async db=>{for(const statement of CLAW_SCHEMA.split(";").map(text=>text.trim()).filter(Boolean))await db.query(statement);});
  const q = (db, sql, values = []) => db.query(sql, [ns, ...values]);
  const one = async (db, sql, values) => (await q(db, sql, values)).rows[0];
  const player = async (db, wallet, lock = false) => {
    const row = await one(db, `SELECT state FROM claw_players WHERE namespace=$1 AND wallet=$2${lock ? " FOR UPDATE" : ""}`, [wallet]);
    if (!row) throw Error("player_not_initialized"); return row.state;
  };
  const write = (db, wallet, state) => q(db, "UPDATE claw_players SET state=$3::jsonb WHERE namespace=$1 AND wallet=$2", [wallet, JSON.stringify(state)]);
  const attempt = (db, wallet, id) => one(db, "SELECT * FROM claw_attempts WHERE namespace=$1 AND wallet=$2 AND id=$3", [wallet, id]);
  const entry = (db, id, wallet, kind, tier, quantity, amount) => q(db,
    "INSERT INTO claw_entries(namespace,id,wallet,kind,tier,quantity,cents,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [id,wallet,kind,tier,quantity,amount,now()]);
  const spent = async (db, wallet) => cents((await one(db, "SELECT COALESCE(SUM(cents),0) AS n FROM claw_withdrawals WHERE namespace=$1 AND wallet=$2 AND status<>'failed'", [wallet])).n);
  async function snapshot(db, wallet) {
    const state = await player(db, wallet), pending = state.pendingId ? await attempt(db, wallet, state.pendingId) : null;
    const withdrawal=paymentsEnabled?await one(db,"SELECT id,cents,status FROM claw_withdrawals WHERE namespace=$1 AND wallet=$2 AND status IN ('reserved','submitted') ORDER BY created LIMIT 1",[wallet]):null;
    return { ...state, namespace: ns, wallet, paymentsEnabled,
      pendingWithdrawal:withdrawal?{id:withdrawal.id,cents:cents(withdrawal.cents),status:withdrawal.status}:null,
      withdrawableCents: paymentsEnabled ? Math.max(0,state.winningsCents-await spent(db,wallet)) : 0,
      pending: pending ? {id:pending.id,pull:pending.pull,error:pending.error} : null };
  }
  const jobs = new Map(), creations = new Map(), settlements = new Map(), reconciliations=new Map(); let queue = Promise.resolve();
  async function ensure(wallet) {
    if (await one(store,"SELECT wallet FROM claw_players WHERE namespace=$1 AND wallet=$2",[wallet])) return;
    if (!creations.has(wallet)) creations.set(wallet,(async()=>{
      const arrangement=rules.dailyArrangement(`ledger-${ns}:${wallet}`,now()),boxes=await physics.create(arrangement.seed,{newWallet:true});
      await store.transaction(async db=>{
        const result=await q(db,"INSERT INTO claw_players VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING RETURNING wallet",[wallet,JSON.stringify({revision:0,arrangement,initialBoxes:boxes,boxes,balances:paymentsEnabled?[0,0,0]:[10,10,10],winningsCents:0,pendingId:null,history:[]})]);
        if(result.rows.length&&!paymentsEnabled)for(let tier=0;tier<3;tier++)await entry(db,`initial:${wallet}:${tier}`,wallet,"test-credit",tier,10,0);
      });
    })().finally(()=>creations.delete(wallet)));
    await creations.get(wallet);
  }
  async function rotate(wallet) {
    const prior=await player(store,wallet),arrangement=rules.dailyArrangement(`ledger-${ns}:${wallet}`,now());
    if(prior.pendingId||prior.arrangement.id===arrangement.id)return;
    const boxes=await physics.create(arrangement.seed);
    await store.transaction(async db=>{const state=await player(db,wallet,true);if(state.pendingId||state.arrangement.id===arrangement.id)return;
      Object.assign(state,{arrangement,initialBoxes:boxes,boxes,revision:state.revision+1});await write(db,wallet,state);});
  }
  async function settle(wallet,id,receipt) {
    if(settlements.has(id))return settlements.get(id);
    const work=(async()=>{
      const row=await attempt(store,wallet,id);if(row.result)return row.result;
      const pull=row.pull,outcome=receipt.result;
      if(!outcome||receipt.gameId!==id||pull.target&&(!receipt.callbackSignature||!receipt.requestSignature))throw Error("verified_result_required");
      if(JSON.stringify(rules.resolvePull(pull,()=>outcome.roll,"magicblock-vrf"))!==JSON.stringify(outcome))throw Error("ledger_result_mismatch");
      const before=await player(store,wallet);if(before.pendingId!==id||before.arrangement.id!==pull.arrangement.id)throw Error("ledger_pending_mismatch");
      const remaining=outcome.success?before.boxes.filter(box=>box.id!==outcome.targetId):before.boxes;
      if(outcome.success&&remaining.length!==before.boxes.length-1)throw Error("prize_already_removed");
      const boxes=outcome.success?await physics.settle(remaining):remaining;
      return store.transaction(async db=>{const state=await player(db,wallet,true),locked=await attempt(db,wallet,id);if(locked.result)return locked.result;
        if(state.pendingId!==id||state.winningsCents+outcome.cents>MAX_CENTS)throw Error("ledger_settlement_blocked");
        await entry(db,`result:${id}`,wallet,"result",pull.tier,0,outcome.cents);
        state.winningsCents+=outcome.cents;state.boxes=boxes;state.pendingId=null;state.revision++;
        state.history=[{id,tier:pull.tier,entryCents:Math.round(pull.priceUsd*100),result:outcome,requestSignature:receipt.requestSignature??null,callbackSignature:receipt.callbackSignature??null,timings:receipt.timings??null},...state.history].slice(0,100);
        await write(db,wallet,state);await q(db,"UPDATE claw_attempts SET result=$3::jsonb,error=NULL WHERE namespace=$1 AND id=$2",[id,JSON.stringify(outcome)]);return outcome;
      });
    })().finally(()=>settlements.delete(id));settlements.set(id,work);return work;
  }
  const empty = pull => ({gameId:pull.id,result:rules.resolvePull(pull,()=>{throw Error("unexpected_draw");},"magicblock-vrf")});
  function start(wallet,id) {
    if(jobs.has(id))return jobs.get(id);
    const work=(game.concurrent?Promise.resolve():queue.catch(()=>{})).then(async()=>{
      const row=await attempt(store,wallet,id);if(!row||row.result)return;
      const receipt=row.pull.target?await game.plan(row.pull):empty(row.pull);if(receipt.result)await settle(wallet,id,receipt);
      await q(store,"UPDATE claw_attempts SET error=NULL WHERE namespace=$1 AND id=$2",[id]);
    }).catch(async error=>{await q(store,"UPDATE claw_attempts SET error=$3 WHERE namespace=$1 AND id=$2 AND result IS NULL",[id,/^[a-z_]+$/.test(error.message)?error.message:"attempt_pending_retry"]);}).finally(()=>jobs.delete(id));
    jobs.set(id,work);if(!game.concurrent)queue=work;return work;
  }
  function reconcile(wallet,id) {
    const key=wallet+":"+id;
    if(!reconciliations.has(key))reconciliations.set(key,(async()=>{
      const row=await attempt(store,wallet,id);if(!row)throw Error("attempt_not_found");if(row.result)return row.result;if(jobs.has(id))return null;
      const receipt=row.pull.target?await game.state(id):empty(row.pull);return receipt.result?settle(wallet,id,receipt):null;
    })().finally(()=>reconciliations.delete(key)));
    return reconciliations.get(key);
  }
  async function auth(token,db=store) {
    if(typeof token!=="string"||!/^[a-f0-9]{64}$/.test(token))throw Error("player_authentication_required");
    const row=await one(db,"SELECT * FROM claw_sessions WHERE namespace=$1 AND hash=$2 AND expires>$3",[hash(token),now()]);if(!row)throw Error("player_authentication_required");return row;
  }
  async function sessionAvailable(db,wallet,session) {
    const gross=cents((await one(db,"SELECT COALESCE(SUM(cents),0) AS n FROM claw_entries WHERE namespace=$1 AND wallet=$2 AND kind='result' AND seq>$3",[wallet,session.start_entry])).n);
    const used=cents((await one(db,"SELECT COALESCE(SUM(session_cents),0) AS n FROM claw_withdrawals WHERE namespace=$1 AND wallet=$2 AND session_hash=$3 AND status<>'failed'",[wallet,session.hash])).n);
    return Math.max(0,gross-used);
  }
  const financial = () => {if(!paymentsEnabled)throw Error("devnet_payments_disabled");};
  const receiptRow = async (table,wallet,id,db=store,lock=false) => {
    if(!["claw_purchases","claw_withdrawals"].includes(table))throw Error("invalid_ledger_table");identifier(id);
    const row=await one(db,`SELECT * FROM ${table} WHERE namespace=$1 AND wallet=$2 AND id=$3${lock?" FOR UPDATE":""}`,[wallet,id]);
    if(!row)throw Error("payment_not_found");return row;
  };
  return {
    namespace:ns,paymentsEnabled,
    // Issuance is stateless: anonymous callers cannot fill a shared quota and lock other
    // wallets out of sign-in. The id carries the nonce and issue time; login checks the
    // nonce's server MAC, rebuilds the exact message from server configuration and records each proof once.
    async challenge(wallet) {
      if(typeof wallet!=="string"||new PublicKey(wallet).toBase58()!==wallet)throw Error("invalid_wallet");
      const issued=now(),nonce=nonces.issue(wallet,issued),expires=issued+60000;
      return {id:`${nonce}.${issued}`,message:challengeMessage(wallet,nonce,issued,expires),expires};
    },
    async login(body) {
      exactRequest(body,["id","wallet","signature"]);
      const proof=parseProof(body);if(!proof)throw Error("invalid_wallet_proof");
      const {nonce,issued}=proof;
      // Time bound, issuance MAC and signature are checked before any database or physics work.
      // A few seconds of tolerance for clock differences between app instances.
      if(issued>now()+5000||proof.expires<=now()||!nonces.valid(body.wallet,nonce,issued))throw Error("invalid_wallet_proof");
      const key=createPublicKey({key:Buffer.concat([Buffer.from("302a300506032b6570032100","hex"),new PublicKey(body.wallet).toBuffer()]),format:"der",type:"spki"});
      const message=challengeMessage(body.wallet,nonce,issued,proof.expires);
      if(!verify(null,Buffer.from(message),key,Buffer.from(body.signature,"hex")))throw Error("invalid_wallet_proof");
      if(await one(store,"SELECT 1 AS used FROM claw_challenges WHERE namespace=$1 AND id=$2",[proof.id]))throw Error("invalid_wallet_proof");
      // A new wallet's pile is created before the proof is consumed, so a busy retry can reuse the same signature.
      await ensure(body.wallet);const token=randomBytes(32).toString("hex"),tokenHash=hash(token),expires=now()+12*3600000;
      await store.transaction(async db=>{
        const changed=await q(db,"INSERT INTO claw_challenges(namespace,id,wallet,message,expires,used) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT DO NOTHING RETURNING id",[proof.id,body.wallet,message,proof.expires]);if(!changed.rows.length)throw Error("wallet_proof_already_used");
        const base=await one(db,"SELECT COALESCE(MAX(seq),0) AS n FROM claw_entries WHERE namespace=$1 AND wallet=$2",[body.wallet]);
        await q(db,"INSERT INTO claw_sessions VALUES($1,$2,$3,$4,$5)",[tokenHash,body.wallet,expires,base.n]);
        // Keep this session and the wallet's newest others, up to the per-wallet limit.
        await q(db,"DELETE FROM claw_sessions WHERE namespace=$1 AND wallet=$2 AND hash<>$3 AND hash NOT IN (SELECT hash FROM claw_sessions WHERE namespace=$1 AND wallet=$2 AND hash<>$3 ORDER BY expires DESC, hash DESC LIMIT $4)",
          [body.wallet,tokenHash,WALLET_SESSION_LIMIT-1]);
      });return {token,expires,state:await snapshot(store,body.wallet)};
    },
    // Revokes only the presenting session. Balances, inventory, pending attempts and withdrawals stay with the wallet.
    async logout(token) {
      if(typeof token!=="string"||!/^[a-f0-9]{64}$/.test(token))throw Error("player_authentication_required");
      if(!(await q(store,"DELETE FROM claw_sessions WHERE namespace=$1 AND hash=$2 RETURNING hash",[hash(token)])).rows.length)throw Error("player_authentication_required");
      return {ok:true};
    },
    authenticate:async token=>(await auth(token)).wallet,
    async sessionSummary(token){
      if(typeof token!=="string"||!/^[a-f0-9]{64}$/.test(token))throw Error("player_authentication_required");
      // One database round trip instead of re-authenticating and rebuilding the full player snapshot twice per poll.
      const row=await one(store,`SELECT
        COALESCE((SELECT SUM(e.cents) FROM claw_entries e WHERE e.namespace=s.namespace AND e.wallet=s.wallet AND e.kind='result' AND e.seq>s.start_entry),0) AS gross,
        CASE WHEN $4::boolean THEN COALESCE((SELECT SUM(w.session_cents) FROM claw_withdrawals w WHERE w.namespace=s.namespace AND w.wallet=s.wallet AND w.session_hash=s.hash AND w.status<>'failed'),0) ELSE 0 END AS used,
        CASE WHEN $4::boolean THEN COALESCE((SELECT SUM(w.cents) FROM claw_withdrawals w WHERE w.namespace=s.namespace AND w.wallet=s.wallet AND w.status<>'failed'),0) ELSE 0 END AS spent,
        p.state->>'winningsCents' AS total
        FROM claw_sessions s JOIN claw_players p ON p.namespace=s.namespace AND p.wallet=s.wallet
        WHERE s.namespace=$1 AND s.hash=$2 AND s.expires>$3`,[hash(token),now(),paymentsEnabled]);
      if(!row)throw Error("player_authentication_required");
      const gross=cents(row.gross);
      return {sessionWinningsCents:gross,sessionWithdrawableCents:paymentsEnabled?Math.max(0,Math.min(gross-cents(row.used),cents(row.total)-cents(row.spent))):0};
    },
    async sessionWinnings(token) {const session=await auth(token);return cents((await one(store,"SELECT COALESCE(SUM(cents),0) AS n FROM claw_entries WHERE namespace=$1 AND wallet=$2 AND kind='result' AND seq>$3",[session.wallet,session.start_entry])).n);},
    async state(wallet) {await rotate(wallet);const state=await player(store,wallet);if(state.pendingId)await reconcile(wallet,state.pendingId);return snapshot(store,wallet);},
    async play(wallet,intent) {
      exactRequest(intent,["requestId","revision","aim","tier"]);identifier(intent.requestId);exactRequest(intent.aim,["x","z"]);
      if(!Number.isSafeInteger(intent.revision)||intent.revision<0||!Number.isInteger(intent.tier)||intent.tier<0||intent.tier>2||![intent.aim.x,intent.aim.z].every(Number.isFinite))throw Error("invalid_play_intent");
      const fingerprint=hash(JSON.stringify([intent.revision,intent.tier,intent.aim.x,intent.aim.z]));
      const prior=await one(store,"SELECT * FROM claw_attempts WHERE namespace=$1 AND wallet=$2 AND request_id=$3",[wallet,intent.requestId]);
      if(prior){if(prior.fingerprint!==fingerprint)throw Error("request_inputs_changed");start(wallet,prior.id);return {id:prior.id,pull:prior.pull,state:await snapshot(store,wallet)};}
      await rotate(wallet);if(!await available())throw Error("sponsor_setup_required");
      const locked=await store.transaction(async db=>{
        const state=await player(db,wallet,true),existing=await one(db,"SELECT * FROM claw_attempts WHERE namespace=$1 AND wallet=$2 AND request_id=$3",[wallet,intent.requestId]);
        if(existing){if(existing.fingerprint!==fingerprint)throw Error("request_inputs_changed");return {id:existing.id,pull:existing.pull};}
        if(state.pendingId)throw Error("player_attempt_pending");if(state.revision!==intent.revision)throw Error("stale_player_state");if(!state.boxes.length)throw Error("machine_empty");if(!state.balances[intent.tier])throw Error("insufficient_tokens");
        const id=randomUUID(),pull={id,rulesVersion:rules.RULES_VERSION,aim:copy(intent.aim),target:rules.selectTarget(intent.aim,state.boxes,intent.tier,{},"USDC"),tier:intent.tier,currency:"USDC",priceUsd:rules.entryPriceUsd(intent.tier,"USDC"),arrangement:state.arrangement};
        await q(db,"INSERT INTO claw_attempts(namespace,id,wallet,request_id,fingerprint,pull) VALUES($1,$2,$3,$4,$5,$6::jsonb)",[id,wallet,intent.requestId,fingerprint,JSON.stringify(pull)]);
        await entry(db,`reserve:${id}`,wallet,"token-debit",intent.tier,-1,0);state.balances[intent.tier]--;state.pendingId=id;state.revision++;await write(db,wallet,state);return {id,pull};
      });start(wallet,locked.id);return {...locked,state:await snapshot(store,wallet)};
    },
    async result(wallet,id,resume=false){identifier(id);const row=await attempt(store,wallet,id);if(!row)throw Error("attempt_not_found");if(resume&&!row.result)start(wallet,id);return {id,pull:row.pull,result:row.result??await reconcile(wallet,id),state:await snapshot(store,wallet)};},
    async creditTest(wallet,body) {
      if(paymentsEnabled)throw Error("test_credit_disabled_for_funded_devnet");exactRequest(body,["requestId","tier","quantity"]);identifier(body.requestId);
      if(!Number.isInteger(body.tier)||body.tier<0||body.tier>2||!Number.isInteger(body.quantity)||body.quantity<1||body.quantity>100)throw Error("invalid_test_credit");
      return store.transaction(async db=>{const state=await player(db,wallet,true),id=`faucet:${wallet}:${body.requestId}`,prior=await one(db,"SELECT tier,quantity FROM claw_entries WHERE namespace=$1 AND id=$2",[id]);
        if(prior){if(prior.tier!==body.tier||prior.quantity!==body.quantity)throw Error("request_inputs_changed");return snapshot(db,wallet);}
        if(state.pendingId)throw Error("player_attempt_pending");const day=new Date(now()).toISOString().slice(0,10),used=Number((await one(db,"SELECT quantity FROM claw_faucets WHERE namespace=$1 AND wallet=$2 AND day=$3",[wallet,day]))?.quantity??0);
        if(used+body.quantity>100)throw Error("daily_test_credit_limit_reached");
        await q(db,"INSERT INTO claw_faucets VALUES($1,$2,$3,$4) ON CONFLICT(namespace,wallet,day) DO UPDATE SET quantity=excluded.quantity",[wallet,day,used+body.quantity]);await entry(db,id,wallet,"test-credit",body.tier,body.quantity,0);state.balances[body.tier]+=body.quantity;state.revision++;await write(db,wallet,state);return snapshot(db,wallet);
      });
    },
    async quotePurchase(wallet,body) {
      financial();exactRequest(body,["requestId","tier","quantity"]);identifier(body.requestId);
      if(!Number.isInteger(body.tier)||body.tier<0||body.tier>2||!Number.isInteger(body.quantity)||body.quantity<1||body.quantity>1000)throw Error("invalid_purchase");
      return store.transaction(async db=>{await player(db,wallet,true);const prior=await one(db,"SELECT * FROM claw_purchases WHERE namespace=$1 AND wallet=$2 AND request_id=$3",[wallet,body.requestId]);
        if(prior){if(prior.tier!==body.tier||prior.quantity!==body.quantity)throw Error("request_inputs_changed");return prior;}
        const amount=Math.round(rules.entryPriceUsd(body.tier,"USDC")*100)*body.quantity,id=randomUUID();
        return (await q(db,"INSERT INTO claw_purchases(namespace,id,wallet,request_id,tier,quantity,cents,status,created) VALUES($1,$2,$3,$4,$5,$6,$7,'quoted',$8) RETURNING *",[id,wallet,body.requestId,body.tier,body.quantity,amount,now()])).rows[0];
      });
    },
    purchase:(wallet,id)=>receiptRow("claw_purchases",wallet,id),
    withdrawal:(wallet,id)=>receiptRow("claw_withdrawals",wallet,id),
    async savePaymentWire(kind,wallet,id,wire,replace=false) {
      financial();const table=kind==="purchase"?"claw_purchases":kind==="withdrawal"?"claw_withdrawals":null;if(!table)throw Error("invalid_payment_kind");
      return store.transaction(async db=>{const row=await receiptRow(table,wallet,id,db,true);
        if(["credited","paid","failed"].includes(row.status))return row;
        if(row.wire&&!replace&&row.wire.signature!==wire.signature)throw Error("payment_already_locked");
        if(replace&&row.wire?.signature===wire.signature)throw Error("payment_wire_not_replaced");
        return (await q(db,`UPDATE ${table} SET wire=$3::jsonb,status=$4 WHERE namespace=$1 AND id=$2 RETURNING *`,[id,JSON.stringify(wire),wire.signed?"submitted":kind==="purchase"?"quoted":row.status])).rows[0];
      });
    },
    async acceptPurchase(wallet,id,proof) {
      financial();return store.transaction(async db=>{const state=await player(db,wallet,true),row=await receiptRow("claw_purchases",wallet,id,db,true);if(row.status==="credited")return snapshot(db,wallet);
        if(proof?.verified!==true||proof.id!==id||proof.wallet!==wallet||proof.tier!==row.tier||proof.quantity!==row.quantity||proof.cents!==cents(row.cents))throw Error("purchase_receipt_mismatch");
        await entry(db,`purchase:${id}`,wallet,"purchase",row.tier,row.quantity,cents(row.cents));state.balances[row.tier]+=row.quantity;state.revision++;await write(db,wallet,state);
        await q(db,"UPDATE claw_purchases SET status='credited',receipt=$3::jsonb WHERE namespace=$1 AND id=$2",[id,JSON.stringify(proof)]);return snapshot(db,wallet);
      });
    },
    async reserveWithdrawal(wallet,token,body) {
      financial();exactRequest(body,["requestId","scope"]);identifier(body.requestId);if(!["session","all"].includes(body.scope))throw Error("invalid_withdrawal_scope");
      return store.transaction(async db=>{const session=await auth(token,db);if(session.wallet!==wallet)throw Error("player_authentication_required");const state=await player(db,wallet,true);
        const prior=await one(db,"SELECT * FROM claw_withdrawals WHERE namespace=$1 AND wallet=$2 AND request_id=$3",[wallet,body.requestId]);
        if(prior){if(prior.scope!==body.scope)throw Error("request_inputs_changed");return prior;}
        const total=Math.max(0,state.winningsCents-await spent(db,wallet)),sessionAmount=Math.min(total,await sessionAvailable(db,wallet,session)),amount=body.scope==="all"?total:sessionAmount;
        if(!amount)throw Error("no_withdrawable_winnings");const id=randomUUID();
        return (await q(db,"INSERT INTO claw_withdrawals(namespace,id,wallet,request_id,session_hash,scope,cents,session_cents,status,created) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'reserved',$9) RETURNING *",[id,wallet,body.requestId,session.hash,body.scope,amount,Math.min(amount,sessionAmount),now()])).rows[0];
      });
    },
    async completeWithdrawal(wallet,id,proof) {
      financial();return store.transaction(async db=>{await player(db,wallet,true);const row=await receiptRow("claw_withdrawals",wallet,id,db,true);if(row.status==="paid")return snapshot(db,wallet);
        if(row.status==="failed"||proof?.verified!==true||proof.id!==id||proof.wallet!==wallet||proof.cents!==cents(row.cents))throw Error("withdrawal_receipt_mismatch");
        await q(db,"UPDATE claw_withdrawals SET status='paid',receipt=$3::jsonb WHERE namespace=$1 AND id=$2",[id,JSON.stringify(proof)]);return snapshot(db,wallet);
      });
    },
    async failWithdrawal(wallet,id,proof) {
      financial();if(proof?.confirmedFailure!==true)throw Error("confirmed_payment_failure_required");
      return store.transaction(async db=>{await player(db,wallet,true);const row=await receiptRow("claw_withdrawals",wallet,id,db,true);
        if(row.status==="paid")throw Error("withdrawal_already_paid");if(!row.wire||row.wire.signature!==proof.signature)throw Error("withdrawal_receipt_mismatch");
        await q(db,"UPDATE claw_withdrawals SET status='failed',receipt=$3::jsonb WHERE namespace=$1 AND id=$2",[id,JSON.stringify(proof)]);return snapshot(db,wallet);
      });
    },
    // A signed purchase whose wire can no longer land and has no finalized receipt returns to 'quoted';
    // its dead wire stays on the row for audit until purchase-plan rebuilds it. A credited row never changes.
    async releasePurchase(wallet,id,signature){
      financial();return store.transaction(async db=>{const row=await receiptRow("claw_purchases",wallet,id,db,true);
        if(row.status!=="submitted"||row.wire?.signature!==signature)return row;
        return (await q(db,"UPDATE claw_purchases SET status='quoted' WHERE namespace=$1 AND id=$2 RETURNING *",[id])).rows[0];});
    },
    // Background batches rotate: the least recently checked rows come first, so rows that stay
    // pending cannot keep later payments out of the batch.
    async pendingPayments(){
      const batch=(table,statuses)=>q(store,`UPDATE ${table} SET last_checked=$2 WHERE namespace=$1 AND id IN (SELECT id FROM ${table}
        WHERE namespace=$1 AND status IN (${statuses}) ORDER BY last_checked ASC NULLS FIRST,created LIMIT 20) RETURNING *`,[now()]);
      return {purchases:(await batch("claw_purchases","'submitted'")).rows,withdrawals:(await batch("claw_withdrawals","'reserved','submitted'")).rows};},
    async sessionWithdrawable(token) {const session=await auth(token),state=await snapshot(store,session.wallet);return Math.min(state.withdrawableCents,await sessionAvailable(store,session.wallet,session));},
    async tick(){
      // Expired rows are already refused; pruning them is bounded housekeeping, not a sign-in step.
      if(now()-pruned>=LOGIN_PRUNE_INTERVAL_MS){pruned=now();
        try{await q(store,"DELETE FROM claw_challenges WHERE namespace=$1 AND expires<$2",[now()]);await q(store,"DELETE FROM claw_sessions WHERE namespace=$1 AND expires<$2",[now()]);}catch{/* Retried on a later tick. */}}
      const rows=(await q(store,"SELECT id,wallet FROM claw_attempts WHERE namespace=$1 AND result IS NULL LIMIT 20")).rows;for(let i=0;i<rows.length;i+=4)await Promise.all(rows.slice(i,i+4).map(async row=>{try{if(!await reconcile(row.wallet,row.id)&&!jobs.has(row.id))start(row.wallet,row.id);}catch{/* Same durable reservation remains. */}}));},
    async idle(){await Promise.all(jobs.values());},
    close:()=>store.close?.(),
  };
}
