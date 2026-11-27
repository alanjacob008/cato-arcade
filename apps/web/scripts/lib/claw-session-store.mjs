import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename } from "node:fs/promises";

// Where the signer session (signer keys, in-flight draws, receipts) is kept between restarts.
// Both stores expose load(): Promise<object | null> and save(session): Promise<void>.

/** Local default: one JSON file, written atomically and fsynced. */
export function fileSessionStore(fileUrl, directoryUrl) {
  return {
    async load() {
      try { return JSON.parse(await readFile(fileUrl, "utf8")); }
      catch (error) { if (error.code === "ENOENT") return null; throw Error("invalid_signing_session"); }
    },
    async save(session) {
      await mkdir(directoryUrl, { recursive: true, mode: 0o700 });
      const temporary = new URL(fileUrl.href + ".tmp"), handle = await open(temporary, "w", 0o600);
      try { await handle.writeFile(JSON.stringify(session, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, fileUrl);
      if (process.platform !== "win32") { const directory = await open(directoryUrl, "r"); try { await directory.sync(); } finally { await directory.close(); } }
    },
  };
}

const SCHEMA = ["CREATE TABLE IF NOT EXISTS claw_signer_state (program text PRIMARY KEY, sealed text NOT NULL, updated bigint NOT NULL)",
  "ALTER TABLE claw_signer_state ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0"];

/**
 * Hosted: one row per program in Postgres, sealed with AES-256-GCM (64-hex key, program as associated data).
 * Fenced: load() claims the next generation, and save() only writes while that generation is current, so an
 * instance that has been replaced (lost its coordinator lock but is still running) fails with claw_state_superseded.
 */
export async function pgSessionStore(store, { program, key }) {
  if (!/^[a-f0-9]{64}$/.test(key ?? "")) throw Error("claw_state_key_required");
  const secret = Buffer.from(key, "hex"), aad = Buffer.from("cato-claw-signer:" + program);
  for (const statement of SCHEMA) await store.query(statement);
  let generation = 0;
  return {
    async load() {
      const { rows } = await store.query("UPDATE claw_signer_state SET generation = generation + 1 WHERE program = $1 RETURNING sealed, generation", [program]);
      if (!rows.length) { generation = 0; return null; }
      generation = Number(rows[0].generation);
      try {
        const bytes = Buffer.from(rows[0].sealed, "base64"), decipher = createDecipheriv("aes-256-gcm", secret, bytes.subarray(0, 12), { authTagLength: 16 });
        if (bytes.length < 29) throw Error("short");
        decipher.setAAD(aad); decipher.setAuthTag(bytes.subarray(12, 28));
        return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8"));
      } catch { throw Error("claw_state_unreadable"); }
    },
    async save(session) {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", secret, iv, { authTagLength: 16 });
      cipher.setAAD(aad);
      const body = Buffer.concat([cipher.update(JSON.stringify(session), "utf8"), cipher.final()]);
      const sealed = Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
      const { rows } = generation === 0
        ? await store.query("INSERT INTO claw_signer_state (program, sealed, updated, generation) VALUES ($1, $2, $3, 1) ON CONFLICT (program) DO NOTHING RETURNING generation", [program, sealed, Date.now()])
        : await store.query("UPDATE claw_signer_state SET sealed = $2, updated = $3 WHERE program = $1 AND generation = $4 RETURNING generation", [program, sealed, Date.now(), generation]);
      if (!rows.length) throw Error("claw_state_superseded");
      generation = Number(rows[0].generation);
    },
  };
}

/**
 * Writes snapshots in call order. A failed write rejects only its own caller (who has not sent anything yet), and
 * later saves still run. claw_state_superseded additionally calls onSuperseded so the runtime can stop.
 */
export function createSaveQueue(store, onSuperseded, {now=()=>performance.now()}={}) {
  let tail = Promise.resolve();
  const stats={pending:0,completed:0,failed:0,lastQueueMs:0,lastWriteMs:0};
  const enqueue=session => {
    const queuedAt=now();
    const snapshot = structuredClone(session);
    stats.pending++;
    const run = tail.catch(() => {}).then(async()=>{
      const startedAt=now();stats.lastQueueMs=Math.round(startedAt-queuedAt);
      try{await store.save(snapshot);stats.completed++;}catch(error){stats.failed++;throw error;}
      finally{stats.lastWriteMs=Math.round(now()-startedAt);stats.pending--;}
    });
    tail = run;
    return run.catch(error => { if (error?.message === "claw_state_superseded") onSuperseded(); throw error; });
  };
  enqueue.stats=()=>({...stats});
  return enqueue;
}
