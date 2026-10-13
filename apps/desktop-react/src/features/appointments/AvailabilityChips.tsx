import { useEffect, useMemo, useState } from 'react';
import type { ApiClient } from '../../api/client';
import { describeSlot, fetchAvailability, slotAt, timeOfLocalInput, visibleSlots, type Availability, type AvailabilityQuery, type AvailabilitySlot } from './availability';

type State = { status: 'idle' } | { status: 'loading' } | { status: 'error' } | { status: 'ready'; data: Availability };

/** 서비스·날짜·담당자·자원이 바뀔 때마다 가용 시간을 새로 읽는다. 늦게 도착한 이전 응답은 버린다. */
export function useAvailability(api: ApiClient, organizationId: string, query: AvailabilityQuery | null): State {
  const [state, setState] = useState<State>({ status: 'idle' });
  const key = query ? JSON.stringify([query.serviceId, query.date, query.staffId ?? '', [...(query.resourceIds ?? [])].sort(), query.excludeAppointmentId ?? '']) : '';
  useEffect(() => {
    if (!query) { setState({ status: 'idle' }); return undefined; }
    let alive = true;
    setState({ status: 'loading' });
    fetchAvailability(api, organizationId, query)
      .then((data) => { if (alive) setState(data ? { status: 'ready', data } : { status: 'idle' }); })
      .catch(() => { if (alive) setState({ status: 'error' }); });
    return () => { alive = false; };
  // query 객체는 매 렌더 새로 만들어지므로 내용 키로만 반응한다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, organizationId, key]);
  return state;
}

export interface AvailabilityChipsProps {
  api: ApiClient;
  organizationId: string;
  /** null이면(서비스·날짜가 아직 없음) 안내 문구만 보인다. */
  query: AvailabilityQuery | null;
  /** datetime-local 값. 선택된 칩과 선택 시각의 가능 여부 표시에 쓴다. */
  startAt: string;
  /** 칩을 누르면 시작 시각(HH:MM)과 그 시각에 가능한 담당자 id 목록을 알린다. */
  onPick: (time: string, availableStaffIds: string[]) => void;
}

function Chip({ slot, selected, title, onPick }: { slot: AvailabilitySlot; selected: boolean; title: string; onPick: () => void }) {
  const className = ['apt-chip', slot.available ? '' : 'is-blocked', selected ? 'is-selected' : ''].filter(Boolean).join(' ');
  return (
    <button type="button" className={className} aria-pressed={selected} aria-disabled={!slot.available} title={title}
      aria-label={`${slot.start} ${slot.available ? '예약 가능' : '예약 불가'}`}
      onClick={() => { if (slot.available) onPick(); }}>
      {slot.start}
    </button>
  );
}

/** 예약 폼의 가능 시간 칩. 불가 시각은 흐리게 두고 사유를 툴팁으로 보여 준다. */
export function AvailabilityChips({ api, organizationId, query, startAt, onPick }: AvailabilityChipsProps) {
  const state = useAvailability(api, organizationId, query);
  const data = state.status === 'ready' ? state.data : null;
  const staffName = useMemo(() => {
    const names = new Map((data?.staff ?? []).map((row) => [row.id, row.name]));
    return (id: string) => names.get(id);
  }, [data]);
  const chosen = timeOfLocalInput(startAt);
  const shown = useMemo(() => visibleSlots(data?.slots ?? []), [data]);
  const current = data ? slotAt(data.slots, chosen) : undefined;

  if (!query) return <p className="muted apt-form__hint" aria-label="가능 시간">서비스를 고르면 가능한 시간이 여기에 보입니다.</p>;
  if (state.status === 'loading' || state.status === 'idle') return <p className="muted apt-form__hint" aria-label="가능 시간">{state.status === 'loading' ? '가능한 시간을 확인하는 중…' : ''}</p>;
  if (state.status === 'error') return <p className="muted apt-form__hint" aria-label="가능 시간">가능 시간을 불러오지 못했습니다. 저장할 때 서버가 다시 확인합니다.</p>;

  const availableCount = shown.filter((slot) => slot.available).length;
  return (
    <section className="apt-avail" aria-label="가능 시간">
      <header className="apt-avail__head">
        <strong>{query.date} 가능 시간</strong>
        <span className="muted">{availableCount > 0 ? `${availableCount}개 · ${data!.duration_minutes}분 서비스` : '없음'}</span>
      </header>
      {shown.length === 0
        ? <p className="muted apt-avail__empty">이 날짜에는 근무시간 안에 예약 가능한 시간이 없습니다. 근무시간·휴무를 확인하거나 다른 날짜를 고르세요.</p>
        : <div className="apt-avail__chips" role="group" aria-label="시작 시각 선택">
            {shown.map((slot) => (
              <Chip key={slot.start} slot={slot} selected={slot.start === chosen} title={describeSlot(slot, staffName)} onPick={() => onPick(slot.start, slot.staff_ids)} />
            ))}
          </div>}
      {current && (
        <p className={current.available ? 'apt-avail__status is-ok' : 'apt-avail__status is-blocked'} role="status">
          {chosen} {current.available ? '예약 가능한 시각입니다.' : `예약이 어려운 시각입니다: ${describeSlot(current, staffName)}`}
        </p>
      )}
      <p className="muted apt-avail__note">안내용입니다. 저장할 때 서버가 다시 확인합니다.</p>
    </section>
  );
}
