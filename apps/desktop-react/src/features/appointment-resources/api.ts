import type { ApiClient } from '../../api/client';
import {
  availabilitySchema, requirementsSavedSchema, requirementsSchema, resourceSchema, resourcesSchema, resourceSetupSchema, serviceListSchema, serviceSchema,
  staffListSchema, staffSchema, timeOffSchema, workingHoursSavedSchema, type ResourceKind, type ResourceRequirement,
} from './schemas';

/** 이 기능이 쓰는 ApiClient의 부분. 테스트에서는 call만 가진 가짜를 넣는다. */
export type CallApi = Pick<ApiClient, 'call'>;
const base = (organizationId: string) => `/organizations/${organizationId}`;

export const resourceApi = {
  listResources: (api: CallApi, organizationId: string) => api.call('GET', `${base(organizationId)}/appointment-resources`, resourcesSchema),
  createResource: (api: CallApi, organizationId: string, input: { name: string; kind: ResourceKind; operation_id: string }) =>
    api.call('POST', `${base(organizationId)}/appointment-resources`, resourceSchema, input),
  updateResource: (api: CallApi, organizationId: string, resourceId: string, input: { name: string; is_active: boolean; expected_version: number; operation_id: string }) =>
    api.call('PUT', `${base(organizationId)}/appointment-resources/${resourceId}`, resourceSchema, input),

  listServices: (api: CallApi, organizationId: string) => api.call('GET', `${base(organizationId)}/appointment-services`, serviceListSchema),
  createService: (api: CallApi, organizationId: string, input: { name: string; duration_minutes: number; buffer_minutes: number }) =>
    api.call('POST', `${base(organizationId)}/appointment-services`, serviceSchema, input),
  listRequirements: (api: CallApi, organizationId: string, serviceId: string) =>
    api.call('GET', `${base(organizationId)}/appointment-services/${serviceId}/resource-requirements`, requirementsSchema),
  getRequirementSetup: (api: CallApi, organizationId: string, serviceId: string) =>
    api.call('GET', `${base(organizationId)}/appointment-services/${serviceId}/resource-setup`, resourceSetupSchema),
  saveRequirements: (api: CallApi, organizationId: string, serviceId: string, input: { requirements: ResourceRequirement[]; expected_version: number; operation_id: string }) =>
    api.call('PUT', `${base(organizationId)}/appointment-services/${serviceId}/resource-requirements`, requirementsSavedSchema, input),

  listStaff: (api: CallApi, organizationId: string) => api.call('GET', `${base(organizationId)}/appointment-staff`, staffListSchema),
  createStaff: (api: CallApi, organizationId: string, input: { name: string }) => api.call('POST', `${base(organizationId)}/appointment-staff`, staffSchema, input),
  getAvailability: (api: CallApi, organizationId: string, staffId: string) => api.call('GET', `${base(organizationId)}/appointment-staff/${staffId}/availability`, availabilitySchema),
  saveWorkingHours: (api: CallApi, organizationId: string, staffId: string, input: { timezone_name: string; hours: { weekday: number; start: string; end: string }[]; expected_version: number; operation_id: string }) =>
    api.call('PUT', `${base(organizationId)}/appointment-staff/${staffId}/working-hours`, workingHoursSavedSchema, input),
  createTimeOff: (api: CallApi, organizationId: string, staffId: string, input: { start_at: string; end_at: string; reason: string; operation_id: string }) =>
    api.call('POST', `${base(organizationId)}/appointment-staff/${staffId}/time-off`, timeOffSchema, input),
  cancelTimeOff: (api: CallApi, organizationId: string, staffId: string, timeOffId: string, input: { expected_version: number; operation_id: string }) =>
    api.call('POST', `${base(organizationId)}/appointment-staff/${staffId}/time-off/${timeOffId}/cancel`, timeOffSchema, input),
};
