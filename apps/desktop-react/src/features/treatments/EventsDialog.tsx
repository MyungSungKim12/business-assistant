import { useCallback, useEffect, useRef, useState } from 'react';
import { ErrorState, LoadingState, Modal } from '@business-assistant/react-ui';
import type { ApiClient } from '../../api/client';
import { treatmentApi } from './api';
import { ACTION_LABELS, eventChanges, localTime } from './logic';
import type { TreatmentEvent } from './schemas';
import { useStable } from './useStable';
import './treatments.css';

type Props = { api: ApiClient; organizationId: string; customerId: string; treatmentId: string; onClose: () => void };

/** 시술 변경 이력(불변 감사 기록). 읽기 전용이며 실패하면 다시 시도할 수 있다. */
export function EventsDialog({ api, organizationId, customerId, treatmentId, onClose: close }: Props) {
  const onClose = useStable(close);
  const [events, setEvents] = useState<TreatmentEvent[] | null>(null);
  const [failed, setFailed] = useState(false);
  const sequence = useRef(0);

  const load = useCallback(async () => {
    const current = ++sequence.current;
    setFailed(false);
    setEvents(null);
    try {
      const rows = await treatmentApi.events(api, organizationId, customerId, treatmentId);
      if (current === sequence.current) setEvents(rows);
    } catch { if (current === sequence.current) setFailed(true); }
  }, [api, organizationId, customerId, treatmentId]);
  useEffect(() => { void load(); return () => { sequence.current += 1; }; }, [load]);

  return (
    <Modal title="시술 변경 이력" size="lg" onClose={onClose}>
      <div className="treatment-dialog">
        {failed && <ErrorState message="변경 이력을 불러오지 못했습니다." onRetry={() => void load()} />}
        {!failed && events === null && <LoadingState label="변경 이력을 불러오는 중…" />}
        {events?.length === 0 && <p className="empty-state">저장된 변경 이력이 없습니다. 기존 기록의 과거 변경은 소급 생성하지 않습니다.</p>}
        {events && events.length > 0 && (
          <ol className="treatment-events" aria-label="변경 이력 목록">
            {events.map((event) => (
              <li key={event.id}>
                <strong>{localTime(event.occurred_at)} · {ACTION_LABELS[event.action] ?? event.action}</strong>
                <div className="muted">기록자 ID: {event.actor_id}</div>
                {event.reason && <div>사유: {event.reason}</div>}
                {eventChanges(event).map((line) => <div key={line}>{line}</div>)}
              </li>
            ))}
          </ol>
        )}
        <div className="ba-actions"><button type="button" onClick={onClose}>닫기</button></div>
      </div>
    </Modal>
  );
}
