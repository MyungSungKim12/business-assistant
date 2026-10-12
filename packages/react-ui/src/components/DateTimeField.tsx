import type { InputHTMLAttributes } from 'react';

export interface DateTimeFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  value: string | null;
  onChange: (value: string | null) => void;
}

export function DateTimeField({ value, onChange, ...props }: DateTimeFieldProps) {
  return <input {...props} type="datetime-local" value={value ?? ''} onChange={(event) => onChange(event.currentTarget.value || null)} />;
}
