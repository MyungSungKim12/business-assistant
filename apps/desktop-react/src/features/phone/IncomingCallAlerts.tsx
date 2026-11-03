import { useEffect, useRef, useState } from 'react';
import type { z } from 'zod';
import type { ApiClient } from '../../api/client';
import type { incomingCallSchema } from '../../api/schemas';
import type { Platform } from '../../platform/types';
import { PhoneMemoDialog } from '../customers/PhoneMemoDialog';
import './incoming-calls.css';
import { useCallerSummaries } from './useCallerSummaries';
import { CallerSummaryView } from './CallerSummaryView';
import { usePrivacy } from '../../lib/privacy/usePrivacy';

type Call = z.infer<typeof incomingCallSchema>;
interface Props { api: ApiClient; organizationId: string; userId: string; enabled: boolean; platform: Platform; osEnabled: boolean; onDirtyChange: (dirty: boolean) => void; onOpenCustomer?: (id: string) => Promise<boolean> }

/** A scoped live inbox: never navigates away from or overwrites the current workspace. */
export function IncomingCallAlerts({ api, organizationId, userId, enabled, platform, osEnabled, onDirtyChange, onOpenCustomer }: Props) {
  const scope = `${userId}:${organizationId}`;
  const privacy = usePrivacy();
  const [inbox, setInbox] = useState<{ scope: string; items: Call[]; error: boolean }>({ scope, items: [], error: false });
  const [selected, setSelected] = useState<{ scope: string; event: Call } | null>(null);
  const [nativeReady, setNativeReady] = useState(false);
  const selectedRef = useRef(selected);
  selectedRef.current=selected;
  const pendingActions=useRef(new Set<string>());
  const inboxRef = useRef(inbox);
  inboxRef.current = inbox;
  const summaries = useCallerSummaries(api, platform, organizationId, scope, enabled, inbox.scope === scope ? inbox.items : []);
  const actions = useRef({ onOpenCustomer, retry: summaries.retry });
  actions.current = { onOpenCustomer, retry: summaries.retry };
  const session = useRef({ scope, cursor: '', seen: new Set<string>() });
  const os = useRef({ platform, osEnabled });
  os.current = { platform, osEnabled };

  // Chromium can freeze a hidden WebView. Keep a WebLock only while the user is
  // signed in, in an eligible org and unlocked; release it on every scope change.
  useEffect(() => {
    if (!enabled || platform.kind !== 'tauri' || !navigator.locks) return;
    let cancelled = false;
    let release = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    void navigator.locks.request('business-assistant-call-listener', () => cancelled ? undefined : held).catch(() => platform.log?.('WARN', 'Background phone listener keepalive unavailable'));
    return () => { cancelled = true; release(); };
  }, [enabled, scope, platform]);

  useEffect(() => {
    if (!enabled || !userId || !organizationId || typeof api.listIncomingCalls !== 'function') return;
    if (session.current.scope !== scope) session.current = { scope, cursor: '', seen: new Set() };
    const current = session.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function poll() {
      try {
        const page = await api.listIncomingCalls(organizationId, current.cursor, 8000);
        if (cancelled) return;
        current.cursor = page.cursor;
        const fresh = page.items.filter(row => Date.parse(row.expires_at) > Date.now() && !current.seen.has(row.id));
        for (const row of fresh) current.seen.add(row.id);
        if (current.seen.size > 200) current.seen = new Set([...current.seen].slice(-100));
        setInbox(previous => ({ scope, items: [...(previous.scope === scope ? previous.items : []), ...fresh].filter(row => Date.parse(row.expires_at) > Date.now()).slice(-20), error: false }));
        if (fresh.length && os.current.osEnabled && !os.current.platform.showIncomingCalls) {
          // The OS lock screen must not expose caller identity or phone numbers.
          void os.current.platform.sendOsNotification?.('고객 전화 수신', 'PC 프로그램에서 고객 정보를 확인하세요.').catch(() => undefined);
        }
        timer = setTimeout(() => void poll(), 100);
      } catch {
        if (cancelled) return;
        setInbox(previous => ({ scope, items: previous.scope === scope ? previous.items.filter(row => Date.parse(row.expires_at) > Date.now()) : [], error: true }));
        timer = setTimeout(() => void poll(), 3000);
      }
    }
    void poll();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [api, organizationId, userId, enabled, scope]);

  useEffect(() => {
    if (!platform.subscribeIncomingCallAction || !enabled) return;
    let cancelled = false;
    let off: (() => void) | undefined;
    void platform.subscribeIncomingCallAction((id, action, customerId) => {
      const current = inboxRef.current;
      const event = current.scope === scope ? current.items.find(row => row.id === id && Date.parse(row.expires_at) > Date.now()) : undefined;
      if (cancelled || !event) return;
      if (action === 'retry') { actions.current.retry(); return; }
      if (action === 'customer') {
        if (customerId && event.matches.some(row => row.customer_id === customerId) && !pendingActions.current.has(id)) {
          pendingActions.current.add(id);
          void (async()=>{
            try {
              const accepted=await actions.current.onOpenCustomer?.(customerId);
              if(accepted&&!cancelled){await platform.completeIncomingCallAction?.(id);void api.acknowledgePhoneInbox?.(organizationId,id).catch(()=>platform.log?.('WARN','Call seen acknowledgement failed'));}
            } catch { platform.log?.('WARN','Call customer action was not completed'); }
            finally {pendingActions.current.delete(id);}
          })();
        }
        return;
      }
      if(selectedRef.current)return;
      selectedRef.current={scope,event};
      setSelected({scope,event});
    }).then(unsubscribe => { if (cancelled) unsubscribe(); else off = unsubscribe; }).catch(() => platform.log?.('WARN', 'Call popup action subscription failed'));
    return () => { cancelled = true; off?.(); };
  }, [platform, scope, enabled]);

  // A memo request is accepted only after its dialog has actually mounted.
  useEffect(()=>{
    if(selected?.scope===scope&&enabled){void platform.completeIncomingCallAction?.(selected.event.id).catch(()=>platform.log?.('WARN','Call memo acknowledgement failed'));void api.acknowledgePhoneInbox?.(organizationId,selected.event.id).catch(()=>platform.log?.('WARN','Call seen acknowledgement failed'));}
  },[selected,scope,enabled,platform,api,organizationId]);

  useEffect(() => {
    if (!platform.showIncomingCalls) return;
    let cancelled = false;
    const calls = enabled && inbox.scope === scope ? inbox.items.filter(row => Date.parse(row.expires_at) > Date.now()).slice(-3).map(row => ({ id: row.id, title: row.matches.length === 1 ? Array.from(row.matches[0]!.name).slice(0, 120).join('') : `같은 번호의 고객 ${row.matches.length}명`, phone: privacy.phone(row.phone_e164), expiresAt: Date.parse(row.expires_at), customers: row.matches.slice(0, 10).map(customer => ({ id: customer.customer_id, name: Array.from(customer.name).slice(0, 120).join('') })), ...(summaries.records[row.id] ? { summary: summaries.records[row.id] } : {}) })) : [];
    void platform.showIncomingCalls(calls).then(() => { if (!cancelled) setNativeReady(true); }).catch(() => {
      if (!cancelled) setNativeReady(false);
      platform.log?.('WARN', 'Independent call popup unavailable; using in-app alert');
    });
    return () => { cancelled = true; };
  }, [inbox, enabled, scope, platform, summaries.records, privacy]);

  useEffect(() => () => { void platform.showIncomingCalls?.([]).catch(() => undefined); }, [platform, scope, enabled]);

  const items = enabled && inbox.scope === scope ? inbox.items : [];
  const opened = selected?.scope === scope ? selected.event : null;
  return <>
    {(!nativeReady && items.length > 0 || (enabled && inbox.scope === scope && inbox.error)) && <aside className="incoming-calls" aria-label="휴대폰 수신 전화">
      {inbox.error && <p className="incoming-calls__status">전화 알림 연결을 재시도하고 있습니다.</p>}
      {(!nativeReady ? items : []).slice(-3).reverse().map(event => <section key={event.id} className="incoming-calls__card" aria-live="polite">
        <span className="incoming-calls__eyebrow">휴대폰 전화 수신</span>
        <strong>{event.matches.length === 1 ? event.matches[0]!.name : `같은 번호의 고객 ${event.matches.length}명`}</strong>
        <span>{privacy.phone(event.phone_e164)}</span>
        <CallerSummaryView summary={summaries.records[event.id]} onRetry={summaries.retry} />
        {onOpenCustomer && event.matches.slice(0, 10).map(customer => <button type="button" key={customer.customer_id} onClick={() => void(async()=>{if(await onOpenCustomer(customer.customer_id))void api.acknowledgePhoneInbox?.(organizationId,event.id).catch(()=>platform.log?.('WARN','Call seen acknowledgement failed'));})()}>{event.matches.length === 1 ? '고객 상세 보기' : `${customer.name} 상세 보기`}</button>)}
        <div><button type="button" onClick={() => setSelected({ scope, event })}>메모 작성</button><button type="button" onClick={() => setInbox(previous => ({ ...previous, items: previous.items.filter(row => row.id !== event.id) }))}>닫기</button></div>
      </section>)}
    </aside>}
    {opened && <PhoneMemoDialog key={`${scope}:${opened.id}`} api={api} organizationId={organizationId} initialCall={opened} onDirtyChange={onDirtyChange} onClose={() => setSelected(null)} />}
  </>;
}
