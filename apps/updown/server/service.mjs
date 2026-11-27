import { maxLeverage } from './orderly.mjs';
import { isActive } from './engine.mjs';
import { GAME_SYMBOL } from '../app/game/market.mjs';

/** An error with an HTTP status for the game API. */
export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * The game's market (GAME_SYMBOL only, when active for this broker) with its
 * current futures data and leverage cap, cached briefly. Zero rows while it is
 * unavailable.
 */
export function createMarkets({ request, brokerId, ttlMs = 15000, now = Date.now }) {
  let rows, time = 0, loading;
  return async function markets() {
    if (rows && now() - time < ttlMs) return { rows, updatedAt: time };
    if (!loading) {
      loading = (async () => {
        const [info, futures, cap] = await Promise.all([request('/v1/public/info'), request('/v1/public/futures'), request('/v1/public/leverage')]);
        rows = info.rows.filter(m => m.symbol === GAME_SYMBOL && m.status === 'ACTIVE' && (!m.broker_id || m.broker_id === brokerId))
          .map(m => ({ ...m, ...futures.rows.find(f => f.symbol === m.symbol), maxLeverage: maxLeverage(m, 0, Number(cap.max_futures_leverage)) }));
        time = now();
      })().finally(() => { loading = undefined; });
    }
    await loading;
    return { rows, updatedAt: time };
  };
}

const ROUND_ACTION = /^\/game-api\/rounds\/([a-zA-Z0-9_-]+)\/(reconcile|extend|close|cancel)$/;

/**
 * The /game-api/* routes, shared by the local worker (server/index.mjs) and the
 * website's serverless route handler (apps/web/app/game-api). Transport-level
 * checks (host, origin, session) stay with each caller.
 *
 * - authorize(accountId): optional, per call (or a default here); throws
 *   HttpError(403) unless the caller may act for that Orderly account. Every round
 *   read and operation goes through it.
 * - tickOnRead: advance an account's due rounds when its rounds are listed, for
 *   deployments without a long-running scheduler (the player's poll drives closes).
 * - POST /game-api/rounds/:id/cancel: cancel a round that is still opening (its
 *   resting quote is pulled; a partial fill is closed and the round ends early).
 *
 * @typedef {(accountId: unknown) => Promise<void>} Authorize
 * @param {{ engine: any, request: (path: string, credential?: any, method?: string, body?: any) => Promise<any>, brokerId: string,
 *   health: () => Promise<object>, authorize?: Authorize, tickOnRead?: boolean }} options
 * @returns {(call: { method: string, pathname: string, searchParams: URLSearchParams, readBody: () => Promise<any>, authorize?: Authorize }) => Promise<{ status: number, body: any }>}
 */
export function createGameApi({ engine, request, brokerId, health, authorize = undefined, tickOnRead = false }) {
  const markets = createMarkets({ request, brokerId });
  const ownedRound = async (id, authorizeAccount) => {
    const owner = await engine.owner(id);
    // Unknown rounds fall through to the engine's own "not found" errors.
    if (owner && authorizeAccount) await authorizeAccount(owner);
    return owner;
  };
  return async function handle({ method, pathname, searchParams, readBody, authorize: authorizeAccount = authorize }) {
    try {
      if (method === 'GET' && pathname === '/game-api/health') return { status: 200, body: await health() };
      if (method === 'GET' && pathname === '/game-api/markets') return { status: 200, body: await markets() };
      if (method === 'GET' && pathname === '/game-api/rounds') {
        const accountId = searchParams.get('accountId');
        if (authorizeAccount) await authorizeAccount(accountId);
        let rows = await engine.list(accountId);
        if (tickOnRead && rows.some(r => isActive(r) || r.resultPending)) {
          await engine.tick({ accountId });
          rows = await engine.list(accountId);
        }
        return { status: 200, body: { rows } };
      }
      if (method === 'POST' && pathname === '/game-api/rounds') {
        const input = await readBody();
        if (authorizeAccount) await authorizeAccount(input?.accountId);
        return { status: 200, body: await engine.start(input) };
      }
      const action = method === 'POST' && ROUND_ACTION.exec(pathname);
      if (action) {
        const [, id, verb] = action;
        const owner = await ownedRound(id, authorizeAccount);
        const input = await readBody();
        if (verb === 'reconcile') return { status: 200, body: await engine.recoverResult(id, input) };
        if (verb === 'extend') return { status: 200, body: await engine.extend(id, input) };
        // Cancel while opening: pull the resting quote, close any partial fill, end the round.
        if (verb === 'cancel') return { status: 200, body: await engine.cancelOpening(id, owner) };
        return { status: 200, body: await engine.close(id, owner) };
      }
      return { status: 404, body: { error: 'Not found.' } };
    } catch (e) {
      return { status: e instanceof HttpError ? e.status : 400, body: { error: e.message || 'Request failed.' } };
    }
  };
}
