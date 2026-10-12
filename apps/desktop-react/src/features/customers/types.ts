import type { Customer } from '../../api/schemas';
export type { Customer };
export type CustomerInput = Omit<Customer, 'id'|'organization_id'>;
export const emptyCustomer = (): CustomerInput => ({ name: '', email: null, phone: null, notes: '', birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active' });
