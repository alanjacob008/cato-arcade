import { RoundEngine } from './engine.mjs';
import { createOrderly } from './orderly.mjs';
import { ORDERLY_API } from '../app/utils/deployment-network.mjs';

/**
 * Ticks every network that has rounds with pending work, not only the one this
 * deployment plays on: after VITE_DEPLOYMENT_ENV changes, rounds still live on the
 * previous network keep closing with that network's Orderly base (their own
 * credentials), so nothing is ever stranded. New rounds start only on `primary`.
 *
 * `allowNetwork(network)` may veto a network (e.g. mainnet on a preview
 * deployment); vetoed networks are skipped and reported.
 *
 * @param {{ store: any, primary: RoundEngine, engineFor?: (network: string) => RoundEngine,
 *   allowNetwork?: (network: string) => boolean, log?: (message: string) => void }} options
 */
export function createNetworkSweeper({ store, primary, engineFor = undefined, allowNetwork = () => true, log = console.warn }) {
  const make = engineFor || (network => new RoundEngine({
    request: createOrderly(ORDERLY_API[network]), store, network, brokerId: primary.brokerId,
    now: primary.now, minTickMs: primary.minTickMs, concurrency: primary.concurrency,
  }));
  const engines = new Map([[primary.network, primary]]);
  const warned = new Set();
  return {
    network: primary.network,
    /** Same contract as RoundEngine.tick; returns the rounds due across networks. */
    async tick(options = {}) {
      let due = await primary.tick(options);
      const networks = store.activeNetworks ? await store.activeNetworks() : [];
      for (const network of networks) {
        if (network === primary.network) continue;
        if (!ORDERLY_API[network] || !allowNetwork(network)) {
          if (!warned.has(network)) { warned.add(network); log(`Up Down: rounds on ${network} have pending work but this deployment may not advance them.`); }
          continue;
        }
        if (!warned.has(network)) { warned.add(network); log(`Up Down: still closing rounds left on ${network} (this deployment plays on ${primary.network}).`); }
        if (options.continueWhile && !options.continueWhile()) break;
        try {
          if (!engines.has(network)) engines.set(network, make(network));
          due += await engines.get(network).tick(options);
        } catch (error) {
          log(`Up Down: could not advance rounds on ${network}: ${error.message}`);
        }
      }
      return due;
    },
  };
}
