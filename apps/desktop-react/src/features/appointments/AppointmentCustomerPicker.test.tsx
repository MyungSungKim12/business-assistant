import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { AppointmentCustomerPicker } from './AppointmentCustomerPicker';
import type { ApiClient } from '../../api/client';
import type { Customer } from '../../api/schemas';
import { emptyCustomer } from '../customers/types';

it('동명이인을 연락처로 구별하고 서버 검색으로 초기 목록 밖 고객을 선택한다', async () => {
  const rows: Customer[] = [{ ...emptyCustomer(), organization_id: 'org', id: 'a', name: '김고객', phone: '01011112222' }, { ...emptyCustomer(), organization_id: 'org', id: 'b', name: '김고객', phone: '01033334444' }];
  const remote = { ...rows[0]!, id: 'c', name: '새고객', phone: '01055556666' };
  const api = { call: vi.fn(async () => ({ items: [remote], total: 1, next_cursor: null })) } as unknown as ApiClient;
  const onChange = vi.fn();
  render(<AppointmentCustomerPicker api={api} organizationId="org" customers={rows} value="a" onChange={onChange} />);
  expect(screen.getByRole('option', { name: '김고객 · 01033334444' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('예약 고객 검색'), { target: { value: '5555' } });
  await screen.findByRole('option', { name: '새고객 · 01055556666' });
  expect(screen.getByRole('option', { name: '김고객 · 01011112222' })).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('고객'), { target: { value: 'c' } });
  expect(onChange).toHaveBeenCalledWith('c', remote);
});
