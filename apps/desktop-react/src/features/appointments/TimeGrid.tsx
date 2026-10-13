import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { Appointment } from '../../api/schemas';
import { formatKstTime, formatMinutes, intervalOnDay, kstParts, type DayInterval } from './appointmentTime';
import { blockBox, computeGridRange, placeBlocks, type GridRange } from './layoutBlocks';
import { isInactiveStatus, statusLabel } from './appointmentRules';

/** 30분 칸의 높이(px). 시간축 높이는 이 값에 비례한다. */
export const SLOT_MINUTES = 30;
export const SLOT_HEIGHT = 28;
const PX_PER_MINUTE = SLOT_HEIGHT / SLOT_MINUTES;

export interface TimeGridColumn {
  key: string;
  /** 열 머리글. */
  header: string;
  subHeader?: string;
  /** 이 열이 나타내는 KST 날짜 키. */
  date: string;
  items: Appointment[];
  /** 빈 칸을 눌렀을 때 폼에 채울 담당자(일 보기). */
  staffId?: string;
  isToday?: boolean;
}

export interface TimeGridProps {
  columns: TimeGridColumn[];
  selectedId: string | null;
  /** 현재 시각(ms). 오늘 열에 현재 시각 선을 그린다. */
  now: number;
  /** false면 빈 칸을 누를 수 없다(보기 전용). */
  canCreate: boolean;
  ariaLabel: string;
  onSelect: (appointment: Appointment) => void;
  onEmptyClick: (column: TimeGridColumn, startMinutes: number) => void;
  /** 블록 안에 보일 글자(고객·서비스 등). */
  renderBlock: (appointment: Appointment) => { title: string; lines: string[] };
  /** 열 최소 너비(px). */
  minColumnWidth?: number;
}

interface PreparedBlock { appointment: Appointment; interval: DayInterval }

/** 시간축 × 열 격자. 일 보기(직원별)와 주 보기(요일별)가 함께 쓴다. */
export function TimeGrid({ columns, selectedId, now, canCreate, ariaLabel, onSelect, onEmptyClick, renderBlock, minColumnWidth = 110 }: TimeGridProps) {
  const prepared = useMemo(() => columns.map((column) => {
    const blocks: PreparedBlock[] = [];
    for (const appointment of column.items) {
      const interval = intervalOnDay(appointment.start_at, appointment.end_at, appointment.buffer_minutes, column.date);
      if (interval) blocks.push({ appointment, interval });
    }
    return blocks;
  }), [columns]);

  const range: GridRange = useMemo(() => computeGridRange(prepared.flat().map((block) => block.interval)), [prepared]);
  const slots = useMemo(() => {
    const list: number[] = [];
    for (let minute = range.startMin; minute < range.endMin; minute += SLOT_MINUTES) list.push(minute);
    return list;
  }, [range]);
  const bodyHeight = slots.length * SLOT_HEIGHT;
  const template: CSSProperties = { gridTemplateColumns: `44px repeat(${Math.max(columns.length, 1)}, minmax(${minColumnWidth}px, 1fr))` };
  const nowParts = kstParts(now);

  // 처음 열 때 현재 시각(없으면 업무 시작) 근처가 보이도록 위로 스크롤해 둔다.
  const scroller = useRef<HTMLDivElement | null>(null);
  const hasToday = columns.some((column) => column.isToday);
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const focusMinute = hasToday ? nowParts.minutes - 60 : range.startMin;
    element.scrollTop = Math.max(0, (focusMinute - range.startMin) * PX_PER_MINUTE);
  // 보기·날짜가 바뀔 때만 위치를 맞춘다(1분마다 바뀌는 now에는 반응하지 않는다).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [columns[0]?.date, columns.length, hasToday]);

  return (
    <div className="apt-grid" role="region" aria-label={ariaLabel}>
      <div className="apt-grid__scroll" ref={scroller}>
        <div className="apt-grid__head" style={template}>
          <div className="apt-grid__corner" />
          {columns.map((column) => (
            <div key={column.key} className={column.isToday ? 'apt-grid__col-head is-today' : 'apt-grid__col-head'}>
              <strong>{column.header}</strong>
              {column.subHeader && <span>{column.subHeader}</span>}
            </div>
          ))}
        </div>
        <div className="apt-grid__body" style={{ ...template, height: bodyHeight }}>
          <div className="apt-grid__axis" aria-hidden="true">
            {slots.filter((minute) => minute % 60 === 0).map((minute) => (
              <span key={minute} style={{ top: (minute - range.startMin) * PX_PER_MINUTE }}>{formatMinutes(minute)}</span>
            ))}
          </div>
          {columns.map((column, columnIndex) => {
            const placed = placeBlocks(prepared[columnIndex].map((block) => ({ id: block.appointment.id, ...block.interval })));
            const byId = new Map(prepared[columnIndex].map((block) => [block.appointment.id, block]));
            const showNow = column.isToday && nowParts.date === column.date && nowParts.minutes >= range.startMin && nowParts.minutes < range.endMin;
            return (
              <div key={column.key} className={column.isToday ? 'apt-col is-today' : 'apt-col'} role="group" aria-label={`${column.header} 일정`}>
                {slots.map((minute) => (canCreate
                  ? (
                    <button
                      key={minute}
                      type="button"
                      className={minute % 60 === 0 ? 'apt-slot apt-slot--hour' : 'apt-slot'}
                      style={{ height: SLOT_HEIGHT }}
                      aria-label={`${column.header} ${formatMinutes(minute)} 빈 시간`}
                      onClick={() => onEmptyClick(column, minute)}
                    />
                  )
                  : <div key={minute} className={minute % 60 === 0 ? 'apt-slot apt-slot--hour' : 'apt-slot'} style={{ height: SLOT_HEIGHT }} />))}
                {placed.map((block) => {
                  const source = byId.get(block.id);
                  if (!source) return null;
                  const { appointment } = source;
                  const box = blockBox(block, range, PX_PER_MINUTE);
                  const text = renderBlock(appointment);
                  const style: CSSProperties = { top: box.top, height: box.height, left: `calc(${box.left}% + 1px)`, width: `calc(${box.width}% - 2px)`, '--apt-buffer': `${box.bufferHeight}px` } as CSSProperties;
                  const classes = ['apt-block', `apt-block--${appointment.status}`];
                  if (isInactiveStatus(appointment.status)) classes.push('is-inactive');
                  if (appointment.id === selectedId) classes.push('is-selected');
                  return (
                    <button
                      key={appointment.id}
                      type="button"
                      className={classes.join(' ')}
                      style={style}
                      data-status={appointment.status}
                      aria-pressed={appointment.id === selectedId}
                      aria-label={`${formatKstTime(appointment.start_at)} ${text.title} ${statusLabel(appointment.status)}`}
                      title={`${formatKstTime(appointment.start_at)}~${formatKstTime(appointment.end_at)} ${text.title} · ${statusLabel(appointment.status)}`}
                      onClick={() => onSelect(appointment)}
                    >
                      <span className="apt-block__time">{formatKstTime(appointment.start_at)}</span>
                      {text.lines.map((line, index) => <span key={index} className="apt-block__line">{line}</span>)}
                    </button>
                  );
                })}
                {showNow && <div className="apt-now" style={{ top: (nowParts.minutes - range.startMin) * PX_PER_MINUTE }} aria-hidden="true" data-testid="now-line" />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
