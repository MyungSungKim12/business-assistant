import { useMemo } from 'react';
import type { Appointment } from '../../api/schemas';
import { intervalOnDay, todayKstKey, weekDaysOf, weekdayLabel } from './appointmentTime';
import { shortName, type NameLookup } from './appointmentRules';
import { TimeGrid, type TimeGridColumn } from './TimeGrid';

export interface WeekGridProps {
  /** 주에 속한 아무 날짜. 월~일 7열을 그린다. */
  day: string;
  items: Appointment[];
  customerName: NameLookup;
  staffName: NameLookup;
  selectedId: string | null;
  now: number;
  canCreate: boolean;
  onSelect: (appointment: Appointment) => void;
  /** 빈 칸 클릭: 그 날짜·시각. */
  onEmptyClick: (date: string, minutes: number) => void;
  canMove?: (appointment: Appointment) => boolean;
  /** 끌어서 옮김: 새 날짜와 시작 분(담당자는 그대로). */
  onMove?: (appointment: Appointment, date: string, minutes: number) => void;
}

/** 주 보기: 시간축 × 7일. 블록에 고객·서비스·담당자 약칭을 보인다. */
export function WeekGrid({ day, items, customerName, staffName, selectedId, now, canCreate, onSelect, onEmptyClick, canMove, onMove }: WeekGridProps) {
  const columns = useMemo<TimeGridColumn[]>(() => {
    const today = todayKstKey(now);
    return weekDaysOf(day).map((date) => ({
      key: date,
      header: `${Number(date.slice(8))}일 (${weekdayLabel(date)})`,
      date,
      isToday: date === today,
      items: items.filter((item) => intervalOnDay(item.start_at, item.end_at, item.buffer_minutes, date) !== null),
    }));
  }, [day, items, now]);

  return (
    <TimeGrid
      columns={columns}
      selectedId={selectedId}
      now={now}
      canCreate={canCreate}
      ariaLabel="주 보기 달력"
      onSelect={onSelect}
      onEmptyClick={(column, minutes) => onEmptyClick(column.date, minutes)}
      canMove={canMove}
      onMove={onMove ? (appointment, column, minutes) => onMove(appointment, column.date, minutes) : undefined}
      renderBlock={(appointment) => ({
        title: `${customerName(appointment.customer_id)} · ${appointment.service_name_snapshot} · ${staffName(appointment.staff_id)}`,
        lines: [`${customerName(appointment.customer_id)} · ${shortName(staffName(appointment.staff_id))}`, appointment.service_name_snapshot],
      })}
      minColumnWidth={96}
    />
  );
}
