import type { ApiClient } from '../../api/client';
import type { Customer, CustomerInput } from './types';
export const customerApi = { list: (api: ApiClient, organizationId: string) => api.listCustomers(organizationId), create: (api: ApiClient, organizationId: string, input: CustomerInput) => api.createCustomer(organizationId, input), update: (api: ApiClient, organizationId: string, id: string, input: Partial<CustomerInput>) => api.updateCustomer(organizationId, id, input), archive: (api: ApiClient, organizationId: string, id: string) => api.archiveCustomer(organizationId, id) };
