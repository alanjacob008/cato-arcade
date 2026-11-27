import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { loadEnv } from 'vite';
import { createOrderly } from './orderly.mjs';
import { createJournalStore, createStore, databaseJournalKey } from './store.mjs';
import { createPostgresStore } from './postgres-store.mjs';
import { createPostgresPool } from './pg-pool.mjs';
import { MAKER_WINDOW_S, RoundEngine, ROUND_DURATIONS } from './engine.mjs';
import { createGameApi } from './service.mjs';
import { createNetworkSweeper } from './sweeper.mjs';
import { ORDERLY_API, parseDeploymentNetwork } from '../app/utils/deployment-network.mjs';

// Local development round service. In production the website (apps/web) runs the
// same engine and routes as serverless functions; see apps/web/app/game-api.
const env = loadEnv('development', process.cwd(), '');
// Same parser as the game bundle and the website: unset = testnet, anything but
// mainnet/testnet stops the worker with a clear error.
const network = parseDeploymentNetwork(env.VITE_DEPLOYMENT_ENV);
const base = ORDERLY_API[network];
const brokerId = env.VITE_ORDERLY_BROKER_ID || 'demo';
const request = createOrderly(base);
const token = randomBytes(32).toString('hex');
// DATABASE_URL (never a VITE_* value) switches the journal from the local encrypted file to the
// website database (updown_rounds). The round credential is sealed with the journal key either way.
// A shared database must be sealed with the shared UPDOWN_JOURNAL_KEY, never this
// machine's .runtime key (databaseJournalKey refuses to start without it).
const store = env.DATABASE_URL
  ? createPostgresStore({ pool: await createPostgresPool(env.DATABASE_URL), key: databaseJournalKey(env) })
  : createJournalStore(createStore('.runtime'));
const engine = new RoundEngine({ request, store, network, brokerId });
// Also keeps closing rounds a previous network setting left in the database.
const sweeper = createNetworkSweeper({ store, primary: engine });
const api = createGameApi({
  engine, request, brokerId,
  health: async () => ({ ready: true, network, journal: env.DATABASE_URL ? 'database' : 'file', time: Date.now(), timeExtensions: true, roundDurations: ROUND_DURATIONS, maker: engine.maker, makerWindowS: MAKER_WINDOW_S }),
});
async function body(req) {
  let data = '';
  for await (const chunk of req) { data += chunk; if (data.length > 16384) throw new Error('Request too large.'); }
  // Never echo the parser's message (it quotes the body back).
  try { return JSON.parse(data || '{}'); } catch { throw new Error('Invalid JSON.'); }
}
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store');
  const send = (status, data) => { res.writeHead(status); res.end(JSON.stringify(data)); };
  try {
    // Loopback only, no CORS. Reject cross-origin and DNS-rebinding requests.
    // :3000 is the main site (apps/web) in `next dev`, when UPDOWN_WORKER_ORIGIN points it here.
    if (!['127.0.0.1:5186', '127.0.0.1:5185', 'localhost:5185', '127.0.0.1:3000', 'localhost:3000'].includes(req.headers.host || '')) return send(403, { error: 'Local requests only.' });
    if (req.headers.origin && !['http://127.0.0.1:5185', 'http://localhost:5185', 'http://127.0.0.1:3000', 'http://localhost:3000'].includes(req.headers.origin)) return send(403, { error: 'Origin rejected.' });
    if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Cross-site requests rejected.' });
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/game-api/session') return send(200, { token, network });
    if (!(req.method === 'GET' && url.pathname === '/game-api/health')) {
      const supplied = Buffer.from(String(req.headers['x-updown-token'] || ''));
      if (supplied.length !== token.length || !timingSafeEqual(supplied, Buffer.from(token))) return send(401, { error: 'Refresh the page to reconnect to the round service.' });
    }
    const result = await api({ method: req.method, pathname: url.pathname, searchParams: url.searchParams, readBody: () => body(req) });
    send(result.status, result.body);
  } catch (e) { send(400, { error: e.message || 'Request failed.' }); }
});
server.listen(5186, '127.0.0.1', () => console.log(`Up Down round service: http://127.0.0.1:5186 (${network})`));
setInterval(() => sweeper.tick().catch(() => console.error('Round journal error; check local storage.')), 1000);
process.on('SIGINT', () => { console.log('Round service stopped. Open positions cannot auto-close until it restarts.'); process.exit(0); });
