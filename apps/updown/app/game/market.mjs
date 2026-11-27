// The one market Up Down plays. Shared by the browser bundle (the game screen),
// the local worker (server/index.mjs via server/engine.mjs and server/service.mjs)
// and the website's round service (apps/web/lib/updownGameApi.ts), so the client
// and every round service agree on the only symbol a round may open.
// Plain JS, like deployment-network.mjs: imported from Node scripts as well as TS.

/** Orderly symbol of the only playable market. */
export const GAME_SYMBOL = 'PERP_BTC_USDC';
