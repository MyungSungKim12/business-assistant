import { z } from 'zod';
import type { ApiClient } from '../../api/client';
import { isDateKey } from './appointmentTime';

/**
 * APT-12 가용 시간 안내. 서버의 appointment-availability 응답을 읽고 칩·사유 문구로 바꾼다.
 * 안내용 계산이므로 저장 시 서버가 근무시간·휴무·예약·자원 충돌을 다시 검사한다.
 */
const blockSchema = z.object({
  code: z.enum(['past', 'outside_hours', 'outside_default_window', 'time_off', 'staff_busy', 'resource_unavailable']),
  staff_id: z.string().nullable(),
  kind: z.enum(['room', 'equipment']).optional(),
  needed: z.number().optional(),
  free: z.number().optional(),
  resource_id: z.string().optional(),
});
const slotSchema = z.object({
  start: z.string(), start_at: z.string(), end_at: z.string(), available: z.boolean(), staff_ids: z.array(z.string()), blocked: z.array(blockSchema),
});
export const availabilitySchema = z.object({
  date: z.string(), service_id: z.string(), duration_minutes: z.number(), buffer_minutes: z.number(), step_minutes: z.number(),
  staff: z.array(z.object({ id: z.string(), name: z.string() })),
  required_resources: z.array(z.object({ kind: z.enum(['room', 'equipment']), quantity: z.number() })),
  slots: z.array(slotSchema),
  advisory: z.string(),
});
export type AvailabilityBlock = z.infer<typeof blockSchema>;
export type AvailabilitySlot = z.infer<typeof slotSchema>;
export type Availability = z.infer<typeof availabilitySchema>;

export type AvailabilityQuery = { serviceId: string; date: string; staffId?: string; resourceIds?: string[]; excludeAppointmentId?: string };

/** 쿼리 문자열. 빈 값은 보내지 않고 자원 id는 정렬해 같은 입력이 같은 요청이 되게 한다. */
export function availabilityPath(organizationId: string, query: AvailabilityQuery): string {
  const params = new URLSearchParams({ service_id: query.serviceId, date: query.date });
  if (query.staffId) params.set('staff_id', query.staffId);
  if (query.resourceIds && query.resourceIds.length > 0) params.set('resource_ids', [...query.resourceIds].sort().join(','));
  if (query.excludeAppointmentId) params.set('exclude_appointment_id', query.excludeAppointmentId);
  return `/organizations/${organizationId}/appointment-availability?${params.toString()}`;
}

/** 서버 응답이 기대한 모양이 아니면(구버전 서버 등) null. 호출자는 안내를 생략한다. */
export async function fetchAvailability(api: ApiClient, organizationId: string, query: AvailabilityQuery): Promise<Availability | null> {
  const result = await api.call('GET', availabilityPath(organizationId, query), availabilitySchema.or(z.unknown()));
  const parsed = availabilitySchema.safeParse(result);
  if(parsed.success&&(parsed.data.date!==query.date||parsed.data.service_id!==query.serviceId))throw new Error('Availability query mismatch');
  return parsed.success ? parsed.data : null;
}

/** datetime-local 값에서 날짜 부분. 형식이 틀리면 null. */
export function dateOfLocalInput(value: string): string | null {
  const date = value.slice(0, 10);
  return isDateKey(date) ? date : null;
}
/** datetime-local 값에서 HH:MM. */
export const timeOfLocalInput = (value: string) => (/T(\d{2}:\d{2})/.exec(value)?.[1] ?? null);

const INFORMATIVE: ReadonlySet<AvailabilityBlock['code']> = new Set(['time_off', 'staff_busy', 'resource_unavailable']);

/**
 * 칩으로 보여 줄 시각. 가능한 시각과, 근무시간 안이지만 휴무·다른 예약·자원 때문에 안 되는 시각만 남긴다
 * (근무시간 밖·지난 시각은 사유가 뻔하므로 숨긴다).
 */
export function visibleSlots(slots: AvailabilitySlot[]): AvailabilitySlot[] {
  return slots.filter((slot) => slot.available || slot.blocked.some((block) => INFORMATIVE.has(block.code)));
}

export function slotAt(slots: AvailabilitySlot[], time: string | null): AvailabilitySlot | undefined {
  return time === null ? undefined : slots.find((slot) => slot.start === time);
}

const resourceKindLabel = (kind: 'room' | 'equipment' | undefined) => (kind === 'room' ? '공간' : kind === 'equipment' ? '장비' : '자원');

/** 불가 사유 한 줄. 담당자 이름은 호출자가 id로 찾아 준다. */
export function describeBlock(block: AvailabilityBlock, staffName: (id: string) => string | undefined): string {
  const who = block.staff_id ? `${staffName(block.staff_id) ?? '담당자'}: ` : '';
  switch (block.code) {
    case 'past': return '이미 지난 시각입니다';
    case 'outside_hours': return `${who}근무시간이 아닙니다`;
    case 'outside_default_window': return `${who}근무시간이 설정되지 않아 안내 시간대(09:00~21:00) 밖입니다`;
    case 'time_off': return `${who}휴무입니다`;
    case 'staff_busy': return `${who}다른 예약이 있습니다`;
    case 'resource_unavailable':
      return block.resource_id && block.needed === undefined
        ? '선택한 공간·장비를 그 시각에 쓸 수 없습니다'
        : `${resourceKindLabel(block.kind)}이 부족합니다 (필요 ${block.needed ?? 1}, 가능 ${block.free ?? 0})`;
    default: return '예약할 수 없습니다';
  }
}

/** 칩 툴팁: 불가 사유를 줄바꿈 없이 이어 붙인다. */
export function describeSlot(slot: AvailabilitySlot, staffName: (id: string) => string | undefined): string {
  const reasons = slot.blocked.map((block) => describeBlock(block, staffName));
  if (slot.available) return reasons.length === 0 ? '예약 가능' : `예약 가능 · 참고: ${reasons.join(', ')}`;
  return reasons.length === 0 ? '예약할 수 없습니다' : reasons.join(', ');
}
