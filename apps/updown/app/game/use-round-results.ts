import { useEffect, useState } from 'react';
import { useAccount, usePrivateQuery } from '@orderly.network/hooks';
import type { API } from '@orderly.network/types';
import type { Round } from './api';
import { positionResult } from './position-result.mjs';
import { gameApi, sameAccount } from './api';
import { getDeviceAuthorization } from './device-authorization';
import { getRuntimeConfig } from '@/utils/runtime-config';

/** Recover older rounds whose local worker already discarded its trading key. */
export function useRoundResults(rounds: Round[]) {
  const { account, state } = useAccount();
  const [recovered, setRecovered] = useState<Record<string, Round>>({});
  // A cancelled opening ends early with its result already confirmed (resultPending false): nothing to recover.
  const unconfirmed = (r: Round) => r.status === 'ended_early' && r.resultPending !== false;
  const pending = rounds.some(r => unconfirmed(r) && r.resultSource !== 'position_history');
  const pendingIds = rounds.filter(r => unconfirmed(r) && sameAccount(r.accountId, state.accountId)).map(r => r.id).join(',');
  useEffect(() => {
    if (!account || !state.accountId || !pendingIds) return;
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const recover = async () => {
      try {
        // Restore only: background history reads must never open a signing popup.
        const key = await getDeviceAuthorization(account, getRuntimeConfig('VITE_ORDERLY_BROKER_ID') || 'demo', Date.now() + 60000, false);
        if (disposed) return;
        for (const id of pendingIds.split(',')) {
          const row = await gameApi<Round>(`/rounds/${id}/reconcile`, { accountId: state.accountId, secretKey: key.secretKey });
          if (disposed) return;
          if (row.resultSource === 'position_history') setRecovered(old => ({ ...old, [id]: row }));
        }
      } catch { /* The SDK history query remains available if device auth is absent. */ }
      if (!disposed) timer = setTimeout(recover, 15000);
    };
    void recover();
    return () => { disposed = true; clearTimeout(timer); };
  }, [account, state.accountId, pendingIds]);
  // The SDK's default GET formatter unwraps data.rows into an array.
  const { data, error } = usePrivateQuery<API.PositionHistory[]>(pending ? '/v1/position_history?limit=1000' : null, {
    refreshInterval: 10000, revalidateOnFocus: true, keepPreviousData: false,
  });
  return {
    rows: rounds.map(r => unconfirmed(r) ? recovered[r.id]?.accountId === r.accountId ? recovered[r.id] : { ...r, ...positionResult(r, data) } : r),
    error: pending && error ? 'Could not refresh the final result. Retrying.' : '',
  };
}
