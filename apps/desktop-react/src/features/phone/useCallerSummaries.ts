import { useEffect, useState } from 'react';
import type { ApiClient } from '../../api/client';
import type { CallerSummary, Platform } from '../../platform/types';
import { loadCallerSummary } from './callerSummary';

type Event = { id: string; phone_e164: string; expires_at: string; matches: { customer_id: string }[] };
const EMPTY: Record<string, CallerSummary> = {};
export function useCallerSummaries(api: ApiClient, platform: Platform, org: string, scope: string, enabled: boolean, events: Event[]) {
  const [retry, setRetry] = useState(0);
  const [data, setData] = useState<{ key: string; records: Record<string, CallerSummary> }>({ key: '', records: {} });
  const calls = events.filter(row => row.matches.length === 1 && Date.parse(row.expires_at) > Date.now()).slice(-3);
  const key = JSON.stringify([scope, enabled, retry, calls.map(row => row.id)]);
  useEffect(() => {
    let alive = true;
    if (!enabled || typeof api.getCallerProfile !== 'function') return;
    for (const call of calls) {
      void loadCallerSummary(api, platform, org, call.matches[0]!.customer_id, call.phone_e164, summary => {
        if (alive && Date.parse(call.expires_at) > Date.now()) setData(previous => ({ key, records: { ...(previous.key === key ? previous.records : {}), [call.id]: summary } }));
      }, () => alive && Date.parse(call.expires_at) > Date.now());
    }
    return () => { alive = false; };
  }, [api, platform, org, key]);
  return { records: data.key === key ? data.records : EMPTY, retry: () => setRetry(value => value + 1) };
}
