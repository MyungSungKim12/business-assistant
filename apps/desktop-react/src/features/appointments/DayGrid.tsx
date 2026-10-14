import { useMemo } from 'react';
import type { Appointment, AppointmentStaff } from '../../api/schemas';
import { intervalOnDay, todayKstKey } from './appointmentTime';
import type { NameLookup } from './appointmentRules';
import { TimeGrid, type TimeGridColumn } from './TimeGrid';

/** 활성 담당자가 아니거나 담당자 정보가 없는 예약을 모으는 열. */
const OTHER_COLUMN = '__other__';

export interface DayGridProps {
  day: string;
  items: Appointment[];
  staff: AppointmentStaff[];
  customerName: NameLookup;
  selectedId: string | null;
  now: number;
  canCreate: boolean;
  onSelect: (appointment: Appointment) => void;
  /** 빈 칸 클릭: 그 담당자·시각(datetime-local 형식의 시작 값은 호출자가 만든다). */
  onEmptyClick: (staffId: string | undefined, minutes: number) => void;
  canMove?: (appointment: Appointment) => boolean;
  /** 끌어서 옮김: 새 담당자(담당자 열일 때)와 시작 분. */
  onMove?: (appointment: Appointment, staffId: string | undefined, minutes: number) => void;
}

/** 일 보기: 시간축 × 담당자 열. */
export function DayGrid({ day, items, staff, customerName, selectedId, now, canCreate, onSelect, onEmptyClick, canMove, onMove }: DayGridProps) {
  const columns = useMemo<TimeGridColumn[]>(() => {
    const isToday = day === todayKstKey(now);
    const onDay = items.filter((item) => intervalOnDay(item.start_at, item.end_at, item.buffer_minutes, day) !== null);
    const known = new Set(staff.map((row) => row.id));
    const staffColumns: TimeGridColumn[] = staff.map((row) => ({
      key: row.id, header: row.name, date: day, staffId: row.id, isToday, items: onDay.filter((item) => item.staff_id === row.id),
    }));
    const others = onDay.filter((item) => !known.has(item.staff_id));
    if (others.length > 0) staffColumns.push({ key: OTHER_COLUMN, header: '기타 담당', subHeader: '비활성·미등록', date: day, isToday, items: others });
    if (staffColumns.length === 0) staffColumns.push({ key: OTHER_COLUMN, header: '담당자 없음', date: day, isToday, items: [] });
    return staffColumns;
  }, [day, items, staff, now]);

  return (
    <TimeGrid
      columns={columns}
      selectedId={selectedId}
      now={now}
      canCreate={canCreate}
      ariaLabel="일 보기 달력"
      onSelect={onSelect}
      onEmptyClick={(column, minutes) => onEmptyClick(column.staffId, minutes)}
      canMove={canMove}
      onMove={onMove ? (appointment, column, minutes) => { if (column.staffId) onMove(appointment, column.staffId, minutes); } : undefined}
      renderBlock={(appointment) => ({
        title: `${customerName(appointment.customer_id)} · ${appointment.service_name_snapshot}`,
        lines: [customerName(appointment.customer_id), appointment.service_name_snapshot],
      })}
      minColumnWidth={120}
    />
  );
}
