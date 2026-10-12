import type { SelectHTMLAttributes } from 'react';

export interface SelectOption<T extends string> { value: T; label: string; disabled?: boolean }
export interface SelectProps<T extends string> extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange'> {
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
}

export function Select<T extends string>({ options, onChange, placeholder, ...props }: SelectProps<T>) {
  return (
    <select {...props} onChange={(event) => onChange(event.currentTarget.value as T)}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map((option) => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
    </select>
  );
}
