import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

/** AES-256-GCM sealing of JSON values. Output layout: iv(12) | tag(16) | ciphertext. */
export function createSealer(key) {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('Journal key must be 32 bytes.');
  return {
    seal(value) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]);
    },
    open(bytes) {
      const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return JSON.parse(Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString());
    },
  };
}

/** Load (or create once) the local machine key used to seal the journal. */
export function loadMachineKey(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyFile = path.join(directory, 'machine.key');
  if (!fs.existsSync(keyFile)) fs.writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
  return fs.readFileSync(keyFile);
}

/**
 * Resolve the journal key: UPDOWN_JOURNAL_KEY (64 hex chars, from secret storage)
 * when set, otherwise the local .runtime machine key. Never a VITE_* value.
 */
export function resolveJournalKey(env, directory) {
  const hex = env.UPDOWN_JOURNAL_KEY?.trim();
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('UPDOWN_JOURNAL_KEY must be 64 hex characters (32 bytes).');
    return Buffer.from(hex, 'hex');
  }
  return loadMachineKey(directory);
}

/**
 * The key for a shared database journal: UPDOWN_JOURNAL_KEY only. Sealing rows
 * in a shared database with this machine's .runtime key would make them
 * unreadable to the website (and to any other machine), so it is refused.
 */
export function databaseJournalKey(env) {
  if (!env.UPDOWN_JOURNAL_KEY?.trim()) {
    throw new Error('DATABASE_URL is set but UPDOWN_JOURNAL_KEY is not. Set the same 64-hex-character key the website uses (never the .runtime machine key), or unset DATABASE_URL to use the local file journal.');
  }
  return resolveJournalKey(env, undefined);
}

/** Local development journal: one encrypted file holding every round. */
export function createStore(directory) {
  const sealer = createSealer(loadMachineKey(directory));
  const file = path.join(directory, 'rounds.enc');
  return {
    load() {
      if (!fs.existsSync(file)) return [];
      return sealer.open(fs.readFileSync(file));
    },
    save(rounds) {
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, sealer.seal(rounds), { mode: 0o600 });
      // On Windows the rename fails with EPERM while another process (search indexer,
      // antivirus, a reader) briefly holds the target open. Retry before giving up.
      for (let attempt = 0; ; attempt++) {
        try { fs.renameSync(tmp, file); return; }
        catch (error) {
          if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt >= 20) throw error;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
        }
      }
    },
  };
}

const activeStatus = r => !['closed', 'failed', 'ended_early'].includes(r.status);
const sameAccount = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const due = r => activeStatus(r) || Boolean(r.resultPending && r.credential);

/**
 * The engine's store contract (see engine.mjs) over a whole-journal persistence
 * ({ load(), save(rounds) }, e.g. createStore above). For the single local worker
 * process only: rounds live in memory, every change rewrites the journal before
 * resolving, and locks are in-process. Serverless deployments use
 * postgres-store.mjs, whose locks and writes are safe across processes.
 */
export function createJournalStore(persistence) {
  const rounds = persistence.load();
  const locks = new Map();
  const write = async () => { await persistence.save(rounds); };
  return {
    assertNetwork(network) {
      if (rounds.some(r => activeStatus(r) && r.network !== network)) throw new Error('Active rounds belong to another network. Restore the prior network to close them.');
    },
    async get(id) { return rounds.find(r => r.id === id); },
    async listAccount(network, accountId) { return rounds.filter(r => sameAccount(r.accountId, accountId) && r.network === network).reverse(); },
    async dueIds(network, accountId) {
      return rounds.filter(r => r.network === network && (accountId === undefined || sameAccount(r.accountId, accountId)) && due(r)).map(r => r.id);
    },
    /** Networks that have rounds with pending work. */
    async activeNetworks() { return [...new Set(rounds.filter(due).map(r => r.network))]; },
    async insert(round) {
      if (rounds.some(r => r.id === round.id)) throw new Error('Round ID is already in use.');
      if (rounds.some(r => r.network === round.network && sameAccount(r.accountId, round.accountId) && activeStatus(r))) throw new Error('Finish the active round before starting another.');
      rounds.push(round);
      try { await write(); } catch (error) { rounds.splice(rounds.indexOf(round), 1); throw error; }
    },
    save: write,
    /** Exclusive in-process locks. Without `wait`, returns { acquired: false } when any name is held or queued. */
    async withLock(names, fn, { wait = false } = {}) {
      const keys = [...new Set(names)];
      if (!wait && keys.some(k => locks.has(k))) return { acquired: false };
      const previous = keys.map(k => locks.get(k)).filter(Boolean);
      let release;
      const current = new Promise(resolve => { release = resolve; });
      for (const k of keys) locks.set(k, current);
      await Promise.all(previous);
      try { return { acquired: true, value: await fn() }; }
      finally { release(); for (const k of keys) if (locks.get(k) === current) locks.delete(k); }
    },
  };
}
