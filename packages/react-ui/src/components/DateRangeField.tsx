import { DateField } from './DateField';

export interface DateRange { from: string | null; to: string | null }
export interface DateRangeFieldProps { value: DateRange; onChange: (value: DateRange) => void; disabled?: boolean }

export function DateRangeField({ value, onChange, disabled }: DateRangeFieldProps) {
  return (
    <div className="ba-date-range" role="group" aria-label="기간">
      <DateField aria-label="시작일" value={value.from} disabled={disabled} onChange={(from) => onChange({ ...value, from })} />
      <span aria-hidden="true">–</span>
      <DateField aria-label="종료일" value={value.to} disabled={disabled} onChange={(to) => onChange({ ...value, to })} />
    </div>
  );
}
