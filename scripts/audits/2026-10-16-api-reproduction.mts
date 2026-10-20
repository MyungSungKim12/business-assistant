/** Regression checks derived from the source audit. Mock HTTP only. */
import assert from 'node:assert/strict';
import { createAppointmentGateway } from '../../apps/api/src/supabase/appointments.ts';
import { createOrganizationGateway } from '../../apps/api/src/supabase/organizations.ts';
import { createApp } from '../../apps/api/src/app.ts';
import { loadAvailability } from '../../apps/api/src/modules/appointment-resources/availabilityRoutes.ts';

const org = '11111111-1111-4111-8111-111111111111';
const customer = '22222222-2222-4222-8222-222222222222';
const staff = '33333333-3333-4333-8333-333333333333';
const service = '44444444-4444-4444-8444-444444444444';
const waitlistId = '55555555-5555-4555-8555-555555555555';
const operation = '66666666-6666-4666-8666-666666666666';
const appointment = { id: '77777777-7777-4777-8777-777777777777', organization_id: org, customer_id: customer, staff_id: staff, service_id: service, service_name_snapshot: '검증 서비스', duration_minutes: 60, buffer_minutes: 10, start_at: '2026-10-20T01:00:00Z', end_at: '2026-10-20T02:00:00Z', status: 'reserved', source: 'manual', cancellation_reason: null, version: 1, memo: '', resource_ids: [] };
const waitlist = { id: waitlistId, organization_id: org, customer_id: customer, staff_id: staff, service_id: service, preferred_date: '2026-10-20', note: '', status: 'booked', version: 2, created_at: '2026-10-16T01:00:00Z' };
const config = { APP_SUPABASE_URL: 'https://audit.invalid', APP_SUPABASE_PUBLISHABLE_KEY: 'not-a-real-key', APP_FILE_BUCKET: 'audit', APP_API_PORT: 8000 };
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

let bookingRpcCalls = 0;
const appointments = createAppointmentGateway(config, (async () => {
  bookingRpcCalls++;
  return json({ appointment, waitlist, replayed: false });
}) as typeof fetch);
let observedStatus = 0;
try {
  await appointments.bookWaitlist('mock-token', org, waitlistId, { staff_id: staff, start_at: appointment.start_at, resource_ids: [], expected_version: 1, operation_id: operation });
} catch (error) { observedStatus = (error as { status?: number }).status ?? -1; }
assert.equal(bookingRpcCalls, 1);
assert.equal(observedStatus, 0, 'Valid waitlist booking must succeed');
console.log('F01: valid booking RPC response accepted.');
for (const invalid of [
  { appointment: { ...appointment, organization_id: customer }, waitlist, replayed: false },
  { appointment, waitlist: { ...waitlist, organization_id: customer }, replayed: false },
  { appointment, waitlist: { ...waitlist, id: customer }, replayed: false },
  { appointment: { ...appointment, customer_id: org }, waitlist, replayed: false },
  { appointment: { ...appointment, service_id: org }, waitlist, replayed: false },
]) {
  const gateway = createAppointmentGateway(config, (async () => json(invalid)) as typeof fetch);
  await assert.rejects(() => gateway.bookWaitlist('mock-token', org, waitlistId, { staff_id: staff, start_at: appointment.start_at, resource_ids: [], expected_version: 1, operation_id: operation }), (error: any) => error.status === 503);
}

const organizations = createOrganizationGateway(config, (async (input: RequestInfo | URL) => {
  const path = new URL(String(input)).pathname;
  if (path === '/auth/v1/user') return json({ id: customer });
  if (path.endsWith('/organization_exists')) return json(true);
  if (path.endsWith('/memberships')) return json([{ role: 'member' }]);
  if (path.endsWith('/subscriptions')) return json([{ status: 'active', ends_at: null, plans: { code: 'PRO', plan_features: [{ feature_code: 'task.basic' }] } }]);
  throw new Error(`Unexpected mock path ${path}`);
}) as typeof fetch);
const app = createApp({ organizations, appointments: { save: async () => appointment, createWaitlist: async () => waitlist } as never });
try {
  const headers = { authorization: 'Bearer mock-token' };
  const regular = await app.inject({ method: 'POST', url: `/api/v1/organizations/${org}/appointments`, headers, payload: { customer_id: customer, staff_id: staff, service_id: service, start_at: appointment.start_at, expected_version: null, operation_id: operation, resource_ids: [] } });
  const waiting = await app.inject({ method: 'POST', url: `/api/v1/organizations/${org}/appointment-waitlist`, headers, payload: { customer_id: customer, service_id: service, operation_id: operation } });
  assert.equal(regular.statusCode, 201);
  assert.equal(waiting.statusCode, 201);
  console.log('F02: member reservation and waitlist authorization agree.');
} finally { await app.close(); }

let assignmentReads = 0;
const availabilityReader = {
  listServices: async () => [{ id: service, is_active: true, duration_minutes: 60, buffer_minutes: 0 }],
  listStaff: async () => [{ id: staff, name: '해당 서비스 미지정 직원', is_active: true }],
  listResources: async () => [], listRequirements: async () => [], listAppointments: async () => [],
  getStaffAvailability: async () => ({ hours: [], time_off: [] }),
  getServiceStaff: async () => { assignmentReads++; return [customer]; }, // another employee only
};
const availability = await loadAvailability(availabilityReader as never, 'mock-token', org, { service_id: service, date: '2026-10-20' }, new Date('2026-10-16T00:00:00Z'));
assert.equal(assignmentReads, 1);
assert.equal(availability.staff.length, 0);
assert.equal(availability.slots.some(slot => slot.available), false);
await assert.rejects(() => loadAvailability(availabilityReader as never, 'mock-token', org, { service_id: service, staff_id: staff, date: '2026-10-20' }), (error: any) => error.status === 422);
availabilityReader.getServiceStaff = async () => [];
const unrestricted = await loadAvailability(availabilityReader as never, 'mock-token', org, { service_id: service, date: '2026-10-20' }, new Date('2026-10-16T00:00:00Z'));
assert.equal(unrestricted.staff.length, 1);
console.log('F03: restricted staff excluded; unconfigured services remain available to active staff.');
