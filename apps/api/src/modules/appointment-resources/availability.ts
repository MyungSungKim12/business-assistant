/**
 * APT-12: 가용 시작 시각 계산(순수 함수). 네트워크·DB 접근이 없다.
 *
 * 이 결과는 예약 화면의 "안내"일 뿐이다. 저장 시점의 진실은 DB 트리거(근무시간·휴무·담당자 겹침·자원 겹침)이며,
 * 두 예약이 동시에 같은 시각을 고르면 나중 저장이 409로 거절된다. 아래 규칙은 마이그레이션 034·037·038의 검사와 같은 식을 쓴다.
 *
 *  - 점유 구간 = [시작, 시작 + 소요 + 여유). 근무시간·휴무·다른 예약·자원 겹침은 모두 점유 구간 기준이다.
 *  - 근무시간: 담당자에게 근무시간 행이 하나도 없으면 제한 없음. 있으면 시작 요일의 한 행이 점유 구간 전체를 같은 날 안에 덮어야 한다
 *    (점심 휴게는 근무 행을 둘로 나눠 표현하므로 점유 구간이 점심에 걸치면 불가).
 *  - 다른 예약: 같은 담당자의 활성 예약(reserved·confirmed·checked_in)과 점유 구간이 겹치면 불가(기존 예약의 여유 시간 포함).
 *  - 자원: 자원은 하나당 동시에 한 예약만 쓴다(용량 1). 서비스 필수 자원은 종류별 수량만큼 빈 자원이 있어야 한다.
 */
export type AvailabilityReasonCode = 'past' | 'outside_hours' | 'outside_default_window' | 'time_off' | 'staff_busy' | 'resource_unavailable';

export type WorkingHourInput = { weekday: number; start_time: string; end_time: string; timezone_name: string };
export type TimeOffInput = { start_at: string; end_at: string };
export type AvailabilityStaffInput = { id: string; name: string; hours: WorkingHourInput[]; time_off: TimeOffInput[] };
export type AvailabilityAppointmentInput = { id: string; staff_id: string; start_at: string; end_at: string; buffer_minutes: number; status: string; resource_ids: string[] };
export type AvailabilityResourceInput = { id: string; kind: 'room' | 'equipment'; name?: string; is_active: boolean };
export type ResourceRequirementInput = { kind: 'room' | 'equipment'; quantity: number };

export type AvailabilityInput = {
  /** 한국 시간(KST) 날짜 YYYY-MM-DD. */
  date: string;
  durationMinutes: number;
  bufferMinutes: number;
  stepMinutes?: number;
  staff: AvailabilityStaffInput[];
  appointments: AvailabilityAppointmentInput[];
  resources: AvailabilityResourceInput[];
  requirements: ResourceRequirementInput[];
  /** 사용자가 고른 자원. 비어 있으면 종류별 수량만 본다. */
  selectedResourceIds?: string[];
  /** 수정 중인 예약은 자기 자신과 겹치지 않는다. */
  excludeAppointmentId?: string;
  /** 이 시각 이전은 과거로 본다(기본: 과거 판정 없음). */
  now?: Date;
};

export type AvailabilityBlock = { code: AvailabilityReasonCode; staff_id: string | null; kind?: 'room' | 'equipment'; needed?: number; free?: number; resource_id?: string };
export type AvailabilitySlot = {
  /** KST 시각 HH:MM. */
  start: string;
  start_at: string;
  end_at: string;
  available: boolean;
  /** 이 시각에 예약 가능한 담당자 id. */
  staff_ids: string[];
  /** 불가 사유(담당자별·자원별). 가능한 시각에도 일부 담당자의 사유가 들어 있을 수 있다. */
  blocked: AvailabilityBlock[];
};

export const ACTIVE_STATUSES = new Set(['reserved', 'confirmed', 'checked_in']);
export const DEFAULT_STEP_MINUTES = 30;
/** 근무시간이 설정되지 않은 담당자에게 안내용으로 쓰는 시간대(DB는 제한하지 않는다). */
export const DEFAULT_WINDOW = { startMinute: 9 * 60, endMinute: 21 * 60 };
const KST_OFFSET = '+09:00';
const MINUTE_MS = 60_000;

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);
  if (!found) {
    found = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    formatters.set(timeZone, found);
  }
  return found;
}

/** 시각을 지정한 시간대의 달력 값으로 풀어 ISO 요일(1=월~7=일)·날짜·하루 중 분을 구한다. */
export function zonedParts(instantMs: number, timeZone: string): { isoWeekday: number; date: string; minuteOfDay: number; secondOfDay: number } {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(instantMs))) parts[part.type] = part.value;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const weekday = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay();
  const secondOfDay = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second);
  return { isoWeekday: weekday === 0 ? 7 : weekday, date, minuteOfDay: Math.floor(secondOfDay / 60), secondOfDay };
}

/** "HH:MM" 또는 "HH:MM:SS"를 하루 중 초로 바꾼다. */
export function clockSeconds(value: string): number {
  const [h = '0', m = '0', s = '0'] = value.split(':');
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;
const iso = (ms: number) => new Date(ms).toISOString();
const kstIso = (date: string, minute: number) => `${date}T${hhmm(minute)}:00${KST_OFFSET}`;

/** 037의 appointment_within_staff_hours와 같은 규칙. */
export function withinStaffHours(hours: WorkingHourInput[], startMs: number, occupiedEndMs: number): boolean {
  if (hours.length === 0) return true;
  return hours.some((hour) => {
    const start = zonedParts(startMs, hour.timezone_name);
    const end = zonedParts(occupiedEndMs, hour.timezone_name);
    return start.isoWeekday === hour.weekday && start.date === end.date
      && start.secondOfDay >= clockSeconds(hour.start_time) && end.secondOfDay <= clockSeconds(hour.end_time);
  });
}

type Occupied = { startMs: number; endMs: number };
function occupiedOf(appointment: AvailabilityAppointmentInput): Occupied {
  return { startMs: Date.parse(appointment.start_at), endMs: Date.parse(appointment.end_at) + appointment.buffer_minutes * MINUTE_MS };
}

type StaffContext = { staff: AvailabilityStaffInput; busy: Occupied[]; timeOff: Occupied[] };

function staffBlock(context: StaffContext, startMs: number, occupiedEndMs: number, startMinute: number): AvailabilityBlock | null {
  const { staff } = context;
  if (!withinStaffHours(staff.hours, startMs, occupiedEndMs)) return { code: 'outside_hours', staff_id: staff.id };
  if (staff.hours.length === 0 && (startMinute < DEFAULT_WINDOW.startMinute || startMinute + (occupiedEndMs - startMs) / MINUTE_MS > DEFAULT_WINDOW.endMinute)) {
    return { code: 'outside_default_window', staff_id: staff.id };
  }
  if (context.timeOff.some((off) => overlaps(startMs, occupiedEndMs, off.startMs, off.endMs))) return { code: 'time_off', staff_id: staff.id };
  if (context.busy.some((busy) => overlaps(startMs, occupiedEndMs, busy.startMs, busy.endMs))) return { code: 'staff_busy', staff_id: staff.id };
  return null;
}

type ResourceContext = {
  active: AvailabilityResourceInput[];
  byResource: Map<string, Occupied[]>;
  requirements: ResourceRequirementInput[];
  selected: string[];
};

function resourceBlocks(context: ResourceContext, startMs: number, occupiedEndMs: number): AvailabilityBlock[] {
  const blocks: AvailabilityBlock[] = [];
  const isFree = (resource: AvailabilityResourceInput) => !(context.byResource.get(resource.id) ?? []).some((busy) => overlaps(startMs, occupiedEndMs, busy.startMs, busy.endMs));
  for (const requirement of context.requirements) {
    const free = context.active.filter((resource) => resource.kind === requirement.kind && isFree(resource)).length;
    if (free < requirement.quantity) blocks.push({ code: 'resource_unavailable', staff_id: null, kind: requirement.kind, needed: requirement.quantity, free });
  }
  for (const id of context.selected) {
    const resource = context.active.find((item) => item.id === id);
    if (!resource) blocks.push({ code: 'resource_unavailable', staff_id: null, resource_id: id });
    else if (!isFree(resource)) blocks.push({ code: 'resource_unavailable', staff_id: null, kind: resource.kind, resource_id: id });
  }
  return blocks;
}

/**
 * 하루(KST) 동안 stepMinutes 간격의 시작 시각마다 가능 여부와 사유를 계산한다.
 * 담당자가 여럿이면 한 명이라도 가능하고 자원 조건을 만족하면 그 시각은 가능하다.
 */
export function computeAvailability(input: AvailabilityInput): AvailabilitySlot[] {
  const step = input.stepMinutes ?? DEFAULT_STEP_MINUTES;
  const occupiedMinutes = input.durationMinutes + input.bufferMinutes;
  const dayStartMs = Date.parse(`${input.date}T00:00:00${KST_OFFSET}`);
  const activeAppointments = input.appointments.filter((item) => ACTIVE_STATUSES.has(item.status) && item.id !== input.excludeAppointmentId);

  const staffContexts: StaffContext[] = input.staff.map((staff) => ({
    staff,
    busy: activeAppointments.filter((item) => item.staff_id === staff.id).map(occupiedOf),
    timeOff: staff.time_off.map((off) => ({ startMs: Date.parse(off.start_at), endMs: Date.parse(off.end_at) })),
  }));
  const byResource = new Map<string, Occupied[]>();
  for (const appointment of activeAppointments) {
    for (const resourceId of appointment.resource_ids) byResource.set(resourceId, [...(byResource.get(resourceId) ?? []), occupiedOf(appointment)]);
  }
  const resourceContext: ResourceContext = {
    active: input.resources.filter((resource) => resource.is_active), byResource, requirements: input.requirements, selected: input.selectedResourceIds ?? [],
  };

  const slots: AvailabilitySlot[] = [];
  for (let minute = 0; minute < 24 * 60; minute += step) {
    const startMs = dayStartMs + minute * MINUTE_MS;
    const occupiedEndMs = startMs + occupiedMinutes * MINUTE_MS;
    const blocked: AvailabilityBlock[] = [];
    const staffIds: string[] = [];
    for (const context of staffContexts) {
      const block = staffBlock(context, startMs, occupiedEndMs, minute);
      if (block) blocked.push(block);
      else staffIds.push(context.staff.id);
    }
    const resourceProblems = resourceBlocks(resourceContext, startMs, occupiedEndMs);
    blocked.push(...resourceProblems);
    const isPast = input.now !== undefined && startMs <= input.now.getTime();
    if (isPast) blocked.unshift({ code: 'past', staff_id: null });
    slots.push({
      start: hhmm(minute), start_at: kstIso(input.date, minute), end_at: iso(startMs + input.durationMinutes * MINUTE_MS),
      available: staffIds.length > 0 && resourceProblems.length === 0 && !isPast,
      staff_ids: staffIds, blocked,
    });
  }
  return slots;
}
