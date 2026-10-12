import type { InputHTMLAttributes } from 'react';

export interface DateFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value' | 'onChange'> {
  value: string | null;
  onChange: (value: string | null) => void;
}

export function DateField({ value, onChange, ...props }: DateFieldProps) {
  return <input {...props} type="date" value={value ?? ''} onChange={(event) => onChange(event.currentTarget.value || null)} />;
}
