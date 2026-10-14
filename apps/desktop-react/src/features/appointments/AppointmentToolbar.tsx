import type { ReactNode } from 'react';
import { formatDateLabel, formatWeekLabel } from './appointmentTime';

export type ViewMode = 'day' | 'week' | 'list';

const viewLabels: { mode: ViewMode; label: string }[] = [
  { mode: 'day', label: '일' },
  { mode: 'week', label: '주' },
  { mode: 'list', label: '목록' },
];

export interface AppointmentToolbarProps {
  view: ViewMode;
  day: string;
  onViewChange: (view: ViewMode) => void;
  onDayChange: (day: string) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  /** 오른쪽 끝에 붙일 추가 버튼(공간·장비 관리 등). */
  extra?: ReactNode;
  /** 주·목록 보기에서 담당자별로 걸러 보는 선택. 일 보기는 담당자 열이 이미 나뉘어 있어 쓰지 않는다. */
  staffFilter?: { options: Array<{ id: string; name: string }>; value: string; onChange: (id: string) => void };
}

/** 보기 전환(일·주·목록), 이전·오늘·다음 이동, 날짜 선택. */
export function AppointmentToolbar({ view, day, onViewChange, onDayChange, onPrev, onNext, onToday, extra, staffFilter }: AppointmentToolbarProps) {
  const unit = view === 'week' ? '주' : '일';
  return (
    <div className="page-toolbar apt-toolbar">
      <div>
        <h1>예약</h1>
        <p className="muted">고객·담당자·서비스 일정을 관리합니다.</p>
      </div>
      <div className="apt-toolbar__controls">
        <div className="apt-segment" role="group" aria-label="보기 전환">
          {viewLabels.map((item) => (
            <button key={item.mode} type="button" aria-pressed={view === item.mode} className={view === item.mode ? 'is-active' : undefined} onClick={() => onViewChange(item.mode)}>{item.label}</button>
          ))}
        </div>
        <div className="apt-nav" role="group" aria-label="날짜 이동">
          <button type="button" aria-label={`이전 ${unit}`} onClick={onPrev}>‹</button>
          <button type="button" onClick={onToday}>오늘</button>
          <button type="button" aria-label={`다음 ${unit}`} onClick={onNext}>›</button>
        </div>
        <strong className="apt-toolbar__label" aria-live="polite">{view === 'week' ? formatWeekLabel(day) : formatDateLabel(day)}</strong>
        <input type="date" aria-label="예약 날짜" value={day} onChange={(event) => { if (event.target.value) onDayChange(event.target.value); }} />
        {staffFilter && view !== 'day' && (
          <select aria-label="담당자 필터" value={staffFilter.value} onChange={(event) => staffFilter.onChange(event.target.value)}>
            <option value="">담당자 전체</option>
            {staffFilter.options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
          </select>
        )}
        {extra}
      </div>
    </div>
  );
}
