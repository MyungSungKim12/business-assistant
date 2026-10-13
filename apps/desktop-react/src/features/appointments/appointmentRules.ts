import type { Appointment } from '../../api/schemas';

export type TargetStatus = 'confirmed' | 'checked_in' | 'completed' | 'canceled' | 'no_show';

export const statusLabels: Record<string, string> = { reserved: '예약', confirmed: '확정', checked_in: '방문', completed: '완료', canceled: '취소', no_show: '노쇼' };
export const statusLabel = (status: string) => statusLabels[status] ?? status;

/** 상태 변경 버튼의 이름. */
export const targetLabels: Record<TargetStatus, string> = { confirmed: '확정', checked_in: '방문', completed: '완료', canceled: '취소', no_show: '노쇼' };

/**
 * 화면에 보여 줄 상태 변경 버튼. 서버 규칙(migrations/034)의 부분집합이다.
 * reserved → confirmed → checked_in → completed 순서로 한 단계씩, 취소·노쇼는 예약·확정 상태에서만 가능하다.
 * 완료·취소·노쇼 예약은 더 바꿀 수 없다.
 */
export function allowedTransitions(status: string): TargetStatus[] {
  switch (status) {
    case 'reserved': return ['confirmed', 'no_show', 'canceled'];
    case 'confirmed': return ['checked_in', 'no_show', 'canceled'];
    case 'checked_in': return ['completed'];
    default: return [];
  }
}

/** 시간·담당자·서비스 변경은 예약·확정 상태에서만 서버가 받는다. */
export const canEditAppointment = (status: string) => status === 'reserved' || status === 'confirmed';

/** 사유 입력이 필요한 전이. */
export const needsReason = (target: TargetStatus) => target === 'canceled' || target === 'no_show';

/** 달력에서 흐리게 그리는(활성이 아닌) 상태. */
export const isInactiveStatus = (status: string) => status === 'canceled' || status === 'no_show';

/** id로 이름을 찾는 함수(고객·담당자). */
export type NameLookup = (id: string) => string;

export function nameLookup(rows: { id: string; name: string }[], fallback: string): NameLookup {
  const map = new Map(rows.map((row) => [row.id, row.name]));
  return (id) => map.get(id) ?? fallback;
}

/** 같은 id의 예약을 새 값으로 바꾸거나 더한다. */
export function mergeAppointments(old: Appointment[], incoming: Appointment[]): Appointment[] {
  const map = new Map(old.map((row) => [row.id, row]));
  for (const row of incoming) map.set(row.id, row);
  return [...map.values()];
}

/** 두 글자 약칭(주 보기용). */
export const shortName = (name: string) => Array.from(name).slice(0, 2).join('');
