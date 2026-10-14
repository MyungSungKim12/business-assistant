import type { Customer } from '../../api/schemas';
export type { Customer };
export type CustomerInput = Omit<Customer, 'id'|'organization_id'>;
export const emptyCustomer = (): CustomerInput => ({ name: '', email: null, phone: null, notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active', marketing_consent: false, marketing_consent_at: null });

/** 서버가 받는 편집 필드만 골라 보낸다. 서버는 알 수 없는 필드(id·조직·등록일·동의 시각)를 거절하므로 읽기 전용 값은 뺀다. */
export function customerPayload(value: CustomerInput): Omit<CustomerInput, 'created_at' | 'marketing_consent_at'> {
  const { created_at: _createdAt, marketing_consent_at: _consentAt, ...rest } = value as CustomerInput & { id?: string; organization_id?: string };
  const { id: _id, organization_id: _organization, ...editable } = rest as typeof rest & { id?: string; organization_id?: string };
  return editable;
}
