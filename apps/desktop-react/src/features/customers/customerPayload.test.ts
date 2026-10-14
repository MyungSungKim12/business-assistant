import { describe, expect, it } from 'vitest';
import { customerPayload, emptyCustomer, type Customer } from './types';

describe('customerPayload', () => {
  it('서버가 거절하는 읽기 전용 필드(id·조직·등록일·동의 시각)를 빼고 편집 필드만 보낸다', () => {
    const customer = {
      ...emptyCustomer(), id: '11111111-1111-4111-8111-111111111111', organization_id: '22222222-2222-4222-8222-222222222222',
      name: '김고객', created_at: '2026-10-01T00:00:00Z', marketing_consent: true, marketing_consent_at: '2026-10-02T00:00:00Z',
    } as Customer;
    const payload = customerPayload(customer);
    expect(Object.keys(payload).sort()).toEqual(['allergies', 'birth_date', 'concerns', 'email', 'last_visit_date', 'marketing_consent', 'name', 'next_visit_date', 'notes', 'phone', 'skin_type', 'status', 'tags']);
    expect(payload).toMatchObject({ name: '김고객', marketing_consent: true });
  });

  it('새 고객의 기본값은 수신 미동의다', () => {
    expect(emptyCustomer()).toMatchObject({ marketing_consent: false, marketing_consent_at: null });
    expect(customerPayload(emptyCustomer())).not.toHaveProperty('marketing_consent_at');
  });
});
