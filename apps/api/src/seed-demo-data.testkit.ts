/* eslint-disable @typescript-eslint/no-explicit-any */
// 데모 시드 스크립트 테스트용 가짜 서버.
// 실제 Fastify 라우트(zod 본문·쿼리 검증, 권한 호출 순서)를 그대로 쓰고, 그 아래 게이트웨이(DB 자리)만 메모리로 대신한다.
// 게이트웨이는 migrations의 핵심 규칙(버전·멱등 키·근무시간·자원 충돌·재고·일 마감 등)을 흉내 낸다.
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { ApiFailure } from './errors.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerOrganizationRoutes } from './routes/organizations.js';
import { registerCustomerRoutes } from './routes/customers.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerAppointmentRoutes } from './routes/appointments.js';
import { registerAppointmentResourceRoutes } from './modules/appointment-resources/routes.js';
import { registerTreatmentRoutes, registerSaleDraftRoutes } from './modules/treatments/routes.js';
import { registerSalesRoutes } from './modules/sales/routes.js';
import { registerCatalogRoutes } from './modules/catalog/routes.js';
import { registerDocumentRoutes } from './modules/documents/routes.js';

type Row = Record<string, any>;

export const TEST_PASSWORD = 'correct-horse-battery-staple';
export const TEST_TOKEN = 'tok-secret-0123456789abcdef';
export const TEST_REFRESH = 'refresh-secret-0123456789';
export const TEST_EMAIL = 'owner@example.com';
export const ORG_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';
export const ALL_FEATURES = ['crm.basic', 'task.basic', 'finance.basic', 'document.template', 'files.basic'];

export type FakeOptions = {
  now: Date;
  role?: 'owner' | 'admin' | 'member';
  features?: string[];
  /** 요청이 라우트에 닿기 전에 가로채 오류를 돌려줄 때 쓴다(상태 코드와 본문). */
  intercept?: (method: string, path: string) => { status: number; body: unknown } | null;
};

const KST = 9 * 3_600_000;
const kst = (ms: number) => { const d = new Date(ms + KST); return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() || 7 }; };
const minutesOf = (clock: string) => { const [h, m] = clock.split(':'); return Number(h) * 60 + Number(m); };
const fix2 = (n: number) => n.toFixed(2);
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const conflict = (message: string) => new ApiFailure(409, message);
const invalid = (message: string) => new ApiFailure(422, message);
const missing = (message: string) => new ApiFailure(404, message);
const ACTIVE = ['reserved', 'confirmed', 'checked_in'];

export function createFakeBackend(options: FakeOptions) {
  const { now } = options;
  const role = options.role ?? 'owner';
  const features = new Set(options.features ?? ALL_FEATURES);
  const stamp = now.toISOString();
  const today = kst(now.getTime()).date;
  const created: Record<string, number> = {};
  const bump = (kind: string) => { created[kind] = (created[kind] ?? 0) + 1; };
  const ops = new Map<string, any>();
  const replay = <T,>(key: string, make: () => T): T => { if (ops.has(key)) return copy(ops.get(key)); const value = make(); ops.set(key, copy(value)); return value; };

  const s = {
    customers: [] as Row[], tasks: [] as Row[], staff: [] as Row[], services: [] as Row[], resources: [] as Row[], requirements: new Map<string, Row[]>(),
    hours: new Map<string, Row[]>(), timeOff: [] as Row[], appointments: [] as Row[], treatments: [] as Row[], drafts: [] as Row[],
    products: [] as Row[], ledger: [] as Row[], visits: [] as Row[], carts: [] as Row[], lines: [] as Row[], receipts: [] as Row[], wallets: [] as Row[],
    walletUsages: [] as Row[], refunds: [] as Row[], returns: [] as Row[], closes: [] as Row[], finance: [] as Row[],
    templates: [] as Row[], versions: [] as Row[], documents: [] as Row[], issued: [] as Row[], events: [] as Row[], files: [] as Row[], uploads: [] as string[],
  };
  const customerOf = (id: string) => s.customers.find((c) => c.id === id);

  /* ---------- 조직·인증 ---------- */
  const organizations: any = {
    async requireAccess(token: string, id: string, feature: string, write = false) {
      if (token !== TEST_TOKEN) throw new ApiFailure(401, 'Not authenticated');
      if (id !== ORG_ID) throw missing('Organization not found');
      if (write && role === 'member') throw new ApiFailure(403, 'Organization management permission required');
      if (!features.has(feature)) throw new ApiFailure(403, 'Feature not available', { feature_code: feature });
      return role;
    },
    async list() { return [{ id: ORG_ID, name: '테스트 매장', slug: 'test', role }]; },
    async entitlements() { return { organization_id: ORG_ID, plan_code: 'PRO', features: [...features] }; },
  };
  const auth: any = {
    async signIn(email: string, password: string) {
      if (email !== TEST_EMAIL || password !== TEST_PASSWORD) throw new Error('bad credentials');
      return { accessToken: TEST_TOKEN, refreshToken: TEST_REFRESH, user: { userId: USER_ID, email, displayName: null } };
    },
  };

  /* ---------- 고객·할 일 ---------- */
  const customers: any = {
    async list() { return copy(s.customers); },
    async create(_t: string, org: string, input: Row) { const row = { id: randomUUID(), organization_id: org, ...input }; s.customers.push(row); bump('customers'); return copy(row); },
    async update(_t: string, _o: string, id: string, patch: Row) { const row = customerOf(id); if (!row) return null; Object.assign(row, patch); return copy(row); },
    async remove() { return false; },
  };
  const tasks: any = {
    async list() { return copy(s.tasks); },
    async create(_t: string, org: string, input: Row) { const row = { id: randomUUID(), organization_id: org, created_by: USER_ID, status: 'open', ...input }; s.tasks.push(row); bump('tasks'); return copy(row); },
    async update(_t: string, _o: string, id: string, patch: Row) { const row = s.tasks.find((t) => t.id === id); if (!row) return null; Object.assign(row, patch); return copy(row); },
    async remove() { return false; },
  };

  /* ---------- 예약 자원·예약 ---------- */
  const staffById = (id: string) => s.staff.find((x) => x.id === id);
  function checkAppointment(input: Row, ignoreId: string | null, service: Row) {
    const start = Date.parse(input.start_at);
    const end = start + service.duration_minutes * 60_000;
    const occupiedEnd = end + service.buffer_minutes * 60_000;
    const hours = s.hours.get(input.staff_id) ?? [];
    if (hours.length > 0) {
      const a = kst(start); const b = kst(occupiedEnd);
      const fits = hours.some((h) => h.weekday === a.weekday && a.date === b.date && a.minutes >= minutesOf(h.start_time) && b.minutes <= minutesOf(h.end_time));
      if (!fits) throw conflict('Appointment outside staff working hours');
    }
    if (s.timeOff.some((o) => o.staff_id === input.staff_id && o.status === 'active' && Date.parse(o.start_at) < occupiedEnd && start < Date.parse(o.end_at))) throw conflict('Appointment overlaps staff time off');
    for (const other of s.appointments) {
      if (other.id === ignoreId || !ACTIVE.includes(other.status)) continue;
      const overlaps = Date.parse(other.start_at) < occupiedEnd && start < Date.parse(other.end_at) + other.buffer_minutes * 60_000;
      if (overlaps && other.staff_id === input.staff_id) throw conflict('Staff slot conflict');
      if (overlaps && other.resource_ids.some((id: string) => input.resource_ids.includes(id))) throw conflict('Appointment resource conflict');
    }
    if (new Set(input.resource_ids).size !== input.resource_ids.length) throw invalid('Duplicate appointment resource');
    for (const id of input.resource_ids) if (!s.resources.some((r) => r.id === id && r.is_active)) throw missing('Active appointment resource not found');
    for (const need of s.requirements.get(service.id) ?? []) {
      const have = input.resource_ids.filter((id: string) => s.resources.find((r) => r.id === id)?.kind === need.kind).length;
      if (have < need.quantity) throw invalid('Required appointment resources missing');
    }
    return { end };
  }
  const appointmentsGateway: any = {
    async list(_t: string, _o: string, q: Row = {}) {
      return copy(s.appointments.filter((a) => (!q.customerId || a.customer_id === q.customerId)
        && (!q.fromDate || kst(Date.parse(a.start_at)).date >= q.fromDate) && (!q.toDate || kst(Date.parse(a.start_at)).date <= q.toDate)));
    },
    async listStaff() { return copy(s.staff); },
    async listServices() { return copy(s.services); },
    async save(_t: string, org: string, id: string | null, input: Row) {
      return replay(`appt:${input.operation_id}`, () => {
        const customer = customerOf(input.customer_id);
        if (!customer || ['blocked', 'inactive'].includes(customer.status)) throw missing('Active customer not found');
        if (!staffById(input.staff_id)?.is_active) throw missing('Active staff not found');
        const service = s.services.find((x) => x.id === input.service_id && x.is_active);
        if (!service) throw missing('Active service not found');
        const { end } = checkAppointment(input, id, service);
        const row: Row = { id: randomUUID(), organization_id: org, customer_id: input.customer_id, staff_id: input.staff_id, service_id: input.service_id, service_name_snapshot: service.name,
          duration_minutes: service.duration_minutes, buffer_minutes: service.buffer_minutes, start_at: input.start_at, end_at: new Date(end).toISOString(), status: 'reserved', source: input.source,
          cancellation_reason: null, version: 1, resource_ids: [...input.resource_ids] };
        s.appointments.push(row); bump('appointments');
        return row;
      });
    },
    async transition(_t: string, org: string, id: string, input: Row) {
      return replay(`appt:${input.operation_id}`, () => {
        const row = s.appointments.find((a) => a.id === id);
        if (!row) throw missing('Appointment not found');
        const ok = (row.status === 'reserved' && ['confirmed', 'checked_in', 'canceled', 'no_show'].includes(input.target_status))
          || (row.status === 'confirmed' && ['checked_in', 'canceled', 'no_show'].includes(input.target_status)) || (row.status === 'checked_in' && input.target_status === 'completed');
        if (row.version !== input.expected_version || !ok) throw conflict('Appointment state conflict');
        if (input.target_status === 'checked_in' && !s.visits.some((v) => v.appointment_id === row.id)) openVisit(org, row.customer_id, row.id);
        Object.assign(row, { status: input.target_status, cancellation_reason: input.target_status === 'canceled' ? input.reason : null, version: row.version + 1 });
        bump('appointment-transitions');
        return copy(row);
      });
    },
  };
  const resourcesGateway: any = {
    async createStaff(_t: string, org: string, name: string) { const row = { id: randomUUID(), organization_id: org, name, is_active: true, schedule_version: 1 }; s.staff.push(row); bump('staff'); return copy(row); },
    async createService(_t: string, org: string, name: string, duration: number, buffer: number) { const row = { id: randomUUID(), organization_id: org, name, duration_minutes: duration, buffer_minutes: buffer, is_active: true, resource_version: 1 }; s.services.push(row); bump('services'); return copy(row); },
    async createResource(_t: string, org: string, name: string, kind: string, op: string) {
      return replay(`resource:${op}`, () => { const row = { id: randomUUID(), organization_id: org, name, kind, is_active: true, version: 1 }; s.resources.push(row); bump('resources'); return row; });
    },
    async listResources() { return copy(s.resources); },
    async updateResource() { throw invalid('not used'); },
    async listRequirements(_t: string, _o: string, id: string) { return copy(s.requirements.get(id) ?? []); },
    async getRequirementSetup(_t: string, _o: string, id: string) {
      const service = s.services.find((x) => x.id === id);
      if (!service) throw missing('Not found');
      return { service_id: id, resource_version: service.resource_version, requirements: copy(s.requirements.get(id) ?? []) };
    },
    async replaceRequirements(_t: string, _o: string, id: string, input: Row) {
      return replay(`req:${input.operation_id}`, () => {
        const service = s.services.find((x) => x.id === id);
        if (!service) throw missing('Appointment service not found');
        if (service.resource_version !== input.expected_version) throw conflict('Service resource requirements changed');
        s.requirements.set(id, copy(input.requirements)); service.resource_version += 1; bump('requirements');
        return { service_id: id, resource_version: service.resource_version, requirements: copy(input.requirements) };
      });
    },
    async getStaffAvailability(_t: string, _o: string, id: string) {
      const staff = staffById(id);
      if (!staff) throw missing('Not found');
      return { staff_id: id, schedule_version: staff.schedule_version, hours: copy(s.hours.get(id) ?? []), time_off: copy(s.timeOff.filter((o) => o.staff_id === id && o.status === 'active')) };
    },
    async replaceStaffHours(_t: string, org: string, id: string, input: Row) {
      return replay(`hours:${input.operation_id}`, () => {
        const staff = staffById(id);
        if (!staff) throw missing('Staff not found');
        if (staff.schedule_version !== input.expected_version) throw conflict('Staff schedule changed');
        const rows = input.hours.map((h: Row) => ({ id: randomUUID(), organization_id: org, staff_id: id, weekday: h.weekday, start_time: h.start, end_time: h.end, timezone_name: input.timezone_name }));
        s.hours.set(id, rows); staff.schedule_version += 1; bump('staff-hours');
        return { staff_id: id, schedule_version: staff.schedule_version, timezone_name: input.timezone_name, hours: copy(rows) };
      });
    },
    async createTimeOff(_t: string, org: string, id: string, input: Row) {
      return replay(`off:${input.operation_id}`, () => {
        if (s.appointments.some((a) => a.staff_id === id && ACTIVE.includes(a.status) && Date.parse(a.start_at) < Date.parse(input.end_at) && Date.parse(input.start_at) < Date.parse(a.end_at) + a.buffer_minutes * 60_000)) throw conflict('Time off overlaps an active appointment');
        if (s.timeOff.some((o) => o.staff_id === id && o.status === 'active' && Date.parse(o.start_at) < Date.parse(input.end_at) && Date.parse(input.start_at) < Date.parse(o.end_at))) throw conflict('Time off overlaps existing time off');
        const row = { id: randomUUID(), organization_id: org, staff_id: id, start_at: input.start_at, end_at: input.end_at, reason: input.reason, status: 'active', version: 1 };
        s.timeOff.push(row); bump('time-off');
        return row;
      });
    },
    async cancelTimeOff() { throw invalid('not used'); },
  };

  /* ---------- 시술·판매 초안 ---------- */
  const treatmentRow = (row: Row) => copy(row);
  const treatmentsGateway: any = {
    async list(_t: string, _o: string, customerId: string) { return s.treatments.filter((t) => t.customer_id === customerId).map(treatmentRow); },
    async create(_t: string, org: string, customerId: string, values: Row) {
      if (!customerOf(customerId)) throw missing('Customer not found');
      const row: Row = { id: randomUUID(), organization_id: org, customer_id: customerId, ...values, status: 'draft', version: 1, started_at: null, ended_at: null,
        consultation_goal: '', consultation_plan: '', cautions_snapshot: {}, cautions_acknowledged_by: null, cautions_acknowledged_at: null };
      s.treatments.push(row); bump('treatments');
      return treatmentRow(row);
    },
    async mutate(_t: string, _o: string, customerId: string, treatmentId: string, m: Row) {
      return replay(`treat:${treatmentId}:${m.operation_id}`, () => {
        const row = s.treatments.find((t) => t.id === treatmentId && t.customer_id === customerId);
        if (!row) throw missing('Treatment not found');
        if (row.version !== m.expected_version) throw conflict('Treatment version conflict');
        const allowed = (m.action === 'edit' && ['draft', 'in_progress', 'legacy'].includes(row.status)) || (m.action === 'correct' && ['completed', 'cancelled', 'legacy'].includes(row.status))
          || (m.action === 'start' && row.status === 'draft') || (m.action === 'complete' && row.status === 'in_progress') || (m.action === 'cancel' && ['draft', 'in_progress'].includes(row.status))
          || (m.action === 'consult' && row.status === 'draft');
        if (!allowed) throw conflict('Invalid treatment transition');
        const customer = customerOf(customerId)!;
        const cautions = { allergies: customer.allergies, skin_type: customer.skin_type, concerns: customer.concerns };
        if (m.action === 'consult') {
          if (m.values.acknowledge_cautions && JSON.stringify(m.values.expected_cautions) !== JSON.stringify(cautions)) throw conflict('Customer cautions changed; review current values');
          Object.assign(row, { consultation_goal: m.values.goal, consultation_plan: m.values.plan, cautions_snapshot: m.values.acknowledge_cautions ? cautions : {},
            cautions_acknowledged_by: m.values.acknowledge_cautions ? USER_ID : null, cautions_acknowledged_at: m.values.acknowledge_cautions ? stamp : null });
        }
        if (m.action === 'start' && (!row.consultation_goal.trim() || !row.cautions_acknowledged_at || JSON.stringify(row.cautions_snapshot) !== JSON.stringify(cautions))) throw conflict('Consultation goal and current caution acknowledgment are required');
        if ((m.action === 'cancel' || m.action === 'correct') && !m.reason) throw invalid('A reason is required');
        if (m.action === 'start') Object.assign(row, { status: 'in_progress', started_at: stamp });
        if (m.action === 'complete') Object.assign(row, { status: 'completed', ended_at: stamp });
        if (m.action === 'cancel') Object.assign(row, { status: 'cancelled', ended_at: stamp });
        row.version += 1; bump('treatment-transitions');
        return treatmentRow(row);
      });
    },
    async events() { return []; }, async listPhotos() { return []; }, async createPhoto() { throw invalid('not used'); }, async deletePhoto() { return false; },
  };
  const renderDraft = (customerId: string, treatmentId: string, values: Row) => {
    const t = s.treatments.find((x) => x.id === treatmentId && x.customer_id === customerId);
    if (!t) throw missing('Treatment not found');
    if (!['completed', 'cancelled'].includes(t.status)) throw invalid('Completed or cancelled treatment required');
    if (t.status === 'cancelled' && !values.partial_reason.trim()) throw invalid('Partial treatment reason required');
    if (values.consent_document_id === null && !values.exception_reason.trim()) throw invalid('Consent exception reason required');
    const amount = fix2(Number(values.amount));
    return { values, line: { description: values.description, quantity: 1, unit_price: amount, line_total: amount, practitioner: t.practitioner }, total_amount: amount,
      source_snapshot: { treatment: { id: t.id, version: t.version, status: t.status }, exception_reason: values.exception_reason }, consent_status: 'not_linked', warnings: [] };
  };
  const draftRow = (row: Row) => { const { operation_id: _omit, ...rest } = row; return copy(rest); };
  const saleDraftsGateway: any = {
    async preview(_t: string, _o: string, customerId: string, treatmentId: string, values: Row) { return renderDraft(customerId, treatmentId, values); },
    async create(_t: string, org: string, customerId: string, treatmentId: string, op: string, expected: Row, confirmed: boolean) {
      return replay(`draft:${op}`, () => {
        if (!confirmed) throw invalid('Explicit confirmation required');
        if (s.drafts.some((d) => d.treatment_id === treatmentId)) throw conflict('Treatment already has a sale draft');
        const preview = renderDraft(customerId, treatmentId, expected.values);
        if (JSON.stringify(preview) !== JSON.stringify(expected)) throw conflict('Preview changed; review again');
        const row = { id: randomUUID(), organization_id: org, customer_id: customerId, treatment_id: treatmentId, status: 'draft', description: expected.values.description, amount: preview.total_amount, source_snapshot: preview.source_snapshot, created_by: USER_ID, created_at: stamp };
        s.drafts.push(row); bump('sale-drafts');
        return draftRow(row);
      });
    },
    async listForTreatment(_t: string, _o: string, _c: string, treatmentId: string) { return s.drafts.filter((d) => d.treatment_id === treatmentId).map(draftRow); },
    async listAll() { return s.drafts.map(draftRow); },
  };

  /* ---------- 상품·재고 ---------- */
  const productRow = (p: Row) => copy(p);
  const catalogProduct = (id: string) => { const p = s.products.find((x) => x.id === id); if (!p) throw missing('Product not found'); return p; };
  /* ---------- 방문·장바구니·수납 ---------- */
  function openVisit(org: string, customerId: string, appointmentId: string | null) {
    const visit = { id: randomUUID(), organization_id: org, customer_id: customerId, appointment_id: appointmentId, status: 'open', opened_at: new Date(now.getTime() + s.visits.length * 1000).toISOString(), closed_at: null, version: 1 };
    const cart = { id: randomUUID(), organization_id: org, visit_id: visit.id, customer_id: customerId, status: 'draft', version: 1, subtotal: 0, discount_total: 0, discount_kind: 'none', discount_value: 0, discount_reason: '', discount_applied_by: null, discount_applied_at: null, total_amount: 0 };
    s.visits.push(visit); s.carts.push(cart); bump('visits');
    return { visit, cart };
  }
  const cartOf = (visitId: string) => { const cart = s.carts.find((c) => c.visit_id === visitId); if (!cart) throw missing('Visit cart not found'); return cart; };
  const visitOf = (visitId: string) => s.visits.find((v) => v.id === visitId)!;
  const lineView = (l: Row) => ({ ...l, unit_price: fix2(l.unit_price), line_total: fix2(l.unit_price * l.quantity) });
  const cartView = (c: Row) => ({ ...c, subtotal: fix2(c.subtotal), discount_total: fix2(c.discount_total), total_amount: fix2(c.total_amount), discount_value: String(c.discount_value) });
  const bundle = (visitId: string) => { const cart = cartOf(visitId); return copy({ visit: visitOf(visitId), cart: cartView(cart), lines: s.lines.filter((l) => l.cart_id === cart.id).map(lineView), discount_history: [] }); };
  const activeLines = (cartId: string) => s.lines.filter((l) => l.cart_id === cartId && l.status === 'active');
  function recalc(cart: Row) {
    const subtotal = activeLines(cart.id).reduce((n, l) => n + l.unit_price * l.quantity, 0);
    const discount = cart.discount_kind === 'amount' ? Math.min(cart.discount_value, subtotal) : cart.discount_kind === 'percent' ? Math.floor(subtotal * cart.discount_value / 100) : 0;
    if (subtotal > 0 && discount >= subtotal) throw invalid('Discount exceeds current cart subtotal');
    Object.assign(cart, { subtotal, discount_total: discount, total_amount: subtotal - discount, version: cart.version + 1, status: 'draft' });
    const visit = visitOf(cart.visit_id);
    if (visit.status === 'checkout_ready') Object.assign(visit, { status: 'open', version: visit.version + 1 });
  }
  const guardEditable = (cart: Row, version: number) => { if (!['draft', 'ready'].includes(cart.status) || cart.version !== version) throw conflict('Cart changed'); };
  const receiptsOf = (cartId: string) => s.receipts.filter((r) => r.cart_id === cartId);
  const grossPaid = (cartId: string) => receiptsOf(cartId).reduce((n, r) => n + r.amount, 0);
  const refundedOf = (cartId: string) => s.refunds.filter((r) => r.cart_id === cartId).reduce((n, r) => n + r.amount, 0);
  const paymentsPayload = (visitId: string) => {
    const cart = cartOf(visitId);
    const gross = grossPaid(cart.id);
    const refunded = refundedOf(cart.id);
    return copy({ visit_id: visitId, cart_id: cart.id, cart_version: cart.version, total_amount: String(cart.total_amount), paid_amount: String(gross - refunded + walletApplied(cart.id)), outstanding_amount: String(cart.total_amount - gross + refunded - walletApplied(cart.id)),
      refunded_amount: String(refunded), currency: 'KRW', status: cart.status,
      receipts: receiptsOf(cart.id).map((r) => ({ id: r.id, method: r.method, amount: String(r.amount), reference: r.reference, received_at: r.received_at, operation_id: r.operation_id })),
      refunds: s.refunds.filter((r) => r.cart_id === cart.id).map((r) => ({ id: r.id, source_id: r.source_id, source_kind: 'receipt', amount: String(r.amount), reason: r.reason, created_at: r.created_at, operation_id: r.operation_id })) });
  };
  const assertDayOpen = () => { if (s.closes.some((c) => c.business_date === today)) throw conflict('Business day is closed'); };
  function settle(cart: Row) {
    const visit = visitOf(cart.visit_id);
    Object.assign(cart, { status: 'paid', version: cart.version + 1 });
    Object.assign(visit, { status: 'closed', closed_at: stamp, version: visit.version + 1 });
    for (const line of activeLines(cart.id).filter((l) => l.source_type !== 'treatment_draft')) {
      const product = s.products.find((p) => p.id === line.source_id);
      if (!product) throw conflict('Catalog source missing');
      if (line.source_type === 'product') {
        if (product.stock_quantity < line.quantity) throw conflict('Insufficient product stock');
        product.stock_quantity -= line.quantity; product.version += 1;
        s.ledger.push({ id: randomUUID(), organization_id: ORG_ID, product_id: product.id, movement_kind: 'sale', quantity: -line.quantity, reason: 'Visit sale', created_by: USER_ID, created_at: stamp });
      }
      if (line.source_type === 'membership') {
        s.wallets.push({ id: randomUUID(), organization_id: ORG_ID, customer_id: cart.customer_id, product_id: product.id, sale_line_id: line.id, name_snapshot: product.name,
          money_balance: Number(product.benefit_money), count_balance: product.benefit_count, valid_from: today, expires_on: null, source_snapshot: {}, created_at: stamp,
          lifecycle_status: 'active', paused_on: null, lifecycle_version: 1, usage_history: [] });
        bump('wallets');
      }
    }
  }
  const walletApplied = (cartId: string) => s.walletUsages.filter((u) => u.cart_id === cartId).reduce((n, u) => n + u.applied, 0);
  const salesGateway: any = {
    async listVisits(_t: string, _o: string, customerId?: string, status?: string) { return copy(s.visits.filter((v) => (!customerId || v.customer_id === customerId) && (!status || v.status === status))); },
    async listCartDrafts() { return copy(s.drafts); },
    async createVisit(_t: string, org: string, customerId: string, op: string) {
      return replay(`visit:${op}`, () => { if (!customerOf(customerId)) throw missing('Customer not found'); const { visit } = openVisit(org, customerId, null); return bundle(visit.id); });
    },
    async getCart(_t: string, _o: string, visitId: string) { return bundle(visitId); },
    async addTreatmentDraft(_t: string, org: string, visitId: string, draftId: string, version: number, op: string) {
      return replay(`cart:${op}`, () => {
        const cart = cartOf(visitId); guardEditable(cart, version);
        const draft = s.drafts.find((d) => d.id === draftId);
        if (!draft) throw missing('Treatment draft not found');
        if (s.lines.some((l) => l.source_id === draftId && l.status === 'active')) throw conflict('Treatment draft already in an active cart');
        s.lines.push({ id: randomUUID(), organization_id: org, cart_id: cart.id, source_type: 'treatment_draft', source_id: draftId, description_snapshot: draft.description, quantity: 1, returned_quantity: 0,
          unit_price: Number(draft.amount), staff_id: null, staff_name_snapshot: '', source_snapshot: {}, status: 'active', removal_reason: '', created_at: stamp, removed_at: null });
        recalc(cart); return bundle(visitId);
      });
    },
    async mutateLine(_t: string, _o: string, visitId: string, lineId: string, version: number, op: string, action: string, values: Row) {
      return replay(`cart:${op}`, () => {
        const cart = cartOf(visitId); guardEditable(cart, version);
        const line = s.lines.find((l) => l.id === lineId && l.cart_id === cart.id);
        if (!line) throw missing('Cart line not found');
        if (action === 'update') { if (values.quantity !== undefined) line.quantity = values.quantity; if (values.unit_price !== undefined) line.unit_price = Number(values.unit_price); }
        if (action === 'remove') Object.assign(line, { status: 'removed', removal_reason: values.reason });
        if (action === 'restore') line.status = 'active';
        recalc(cart); return bundle(visitId);
      });
    },
    async review(_t: string, _o: string, visitId: string, version: number, op: string, ready: boolean) {
      return replay(`cart:${op}`, () => {
        const cart = cartOf(visitId); const visit = visitOf(visitId);
        if (cart.version !== version || !['draft', 'ready'].includes(cart.status)) throw conflict('Cart changed');
        if (ready && activeLines(cart.id).length === 0) throw invalid('Empty cart cannot be ready');
        Object.assign(cart, { status: ready ? 'ready' : 'draft', version: cart.version + 1 });
        Object.assign(visit, { status: ready ? 'checkout_ready' : 'open', version: visit.version + 1 });
        return bundle(visitId);
      });
    },
    async applyDiscount(_t: string, _o: string, visitId: string, kind: string, value: string, reason: string, version: number, op: string, confirmed: boolean) {
      return replay(`cart:${op}`, () => {
        const cart = cartOf(visitId);
        if (!confirmed || cart.version !== version || !['draft', 'ready'].includes(cart.status)) throw conflict('Cart changed or payment has started');
        if (receiptsOf(cart.id).length > 0) throw conflict('Discount is frozen after payment starts');
        Object.assign(cart, { discount_kind: kind, discount_value: Number(value), discount_reason: reason });
        recalc(cart); return bundle(visitId);
      });
    },
    async cancelVisit() { throw invalid('not used'); },
    async getPayments(_t: string, _o: string, visitId: string) { return paymentsPayload(visitId); },
    async recordPayment(_t: string, org: string, visitId: string, version: number, op: string, parts: Row[], confirmed: boolean) {
      return replay(`pay:${op}`, () => {
        const cart = cartOf(visitId); const visit = visitOf(visitId);
        if (!confirmed || cart.version !== version || !['ready', 'collecting'].includes(cart.status) || visit.status !== 'checkout_ready') throw conflict('Cart changed');
        assertDayOpen();
        const total = parts.reduce((n, p) => n + Number(p.amount), 0);
        const already = grossPaid(cart.id) + walletApplied(cart.id);
        if (already + total > cart.total_amount) throw invalid('Payment exceeds outstanding amount');
        const hasProduct = activeLines(cart.id).some((l) => l.source_type === 'product');
        if (hasProduct && already + total < cart.total_amount) throw invalid('Product cart requires full payment');
        for (const p of parts) {
          s.receipts.push({ id: randomUUID(), cart_id: cart.id, visit_id: visitId, method: p.method, amount: Number(p.amount), reference: p.reference, received_at: stamp, operation_id: op });
          s.finance.push({ id: randomUUID(), organization_id: org, created_by: USER_ID, transaction_type: 'income', amount: fix2(Number(p.amount)), transaction_date: today, category: 'Visit payment', counterparty: '', memo: `Visit ${visitId}`, is_archived: false, created_at: stamp, updated_at: stamp });
          bump('receipts');
        }
        if (already + total === cart.total_amount) settle(cart); else Object.assign(cart, { status: 'collecting', version: cart.version + 1 });
        return paymentsPayload(visitId);
      });
    },
    async refundPayment(_t: string, _o: string, visitId: string, sourceId: string, amount: string, reason: string, version: number, op: string, confirmed: boolean) {
      return replay(`pay:${op}`, () => {
        const cart = cartOf(visitId);
        if (!confirmed || cart.version !== version || !['collecting', 'paid', 'void'].includes(cart.status)) throw conflict('Cart changed');
        assertDayOpen();
        const receipt = s.receipts.find((r) => r.id === sourceId && r.cart_id === cart.id);
        if (!receipt) throw missing('Refund source not found');
        const already = s.refunds.filter((r) => r.source_id === sourceId).reduce((n, r) => n + r.amount, 0);
        if (already + Number(amount) > receipt.amount) throw invalid('Refund exceeds original receipt');
        s.refunds.push({ id: randomUUID(), cart_id: cart.id, source_id: sourceId, amount: Number(amount), reason, created_at: stamp, operation_id: op });
        bump('refunds'); cart.version += 1;
        return paymentsPayload(visitId);
      });
    },
    async returnProduct(_t: string, _o: string, visitId: string, v: Row) {
      return replay(`pay:${v.operation_id}`, () => {
        const cart = cartOf(visitId);
        if (!v.confirmed || cart.version !== v.expected_version || !['collecting', 'paid', 'void'].includes(cart.status)) throw conflict('Cart changed');
        assertDayOpen();
        const line = s.lines.find((l) => l.id === v.sale_line_id && l.cart_id === cart.id && l.source_type === 'product');
        if (!line) throw missing('Product sale line not found');
        if (v.quantity > line.quantity - line.returned_quantity) throw invalid('Return quantity exceeds sold quantity');
        if (Number(v.amount) > line.unit_price * v.quantity) throw invalid('Refund exceeds returned item value');
        const receipt = s.receipts.find((r) => r.id === v.receipt_id && r.cart_id === cart.id);
        if (!receipt) throw missing('Receipt not found for this visit');
        const already = s.refunds.filter((r) => r.source_id === receipt.id).reduce((n, r) => n + r.amount, 0);
        if (already + Number(v.amount) > receipt.amount) throw invalid('Refund exceeds original receipt');
        line.returned_quantity += v.quantity;
        const product = s.products.find((p) => p.id === line.source_id)!;
        if (v.restock) { product.stock_quantity += v.quantity; product.version += 1; }
        s.refunds.push({ id: randomUUID(), cart_id: cart.id, source_id: receipt.id, amount: Number(v.amount), reason: v.reason, created_at: stamp, operation_id: v.operation_id });
        bump('returns'); cart.version += 1;
        return paymentsPayload(visitId);
      });
    },
    getSettlement: async (_t: string, org: string, date: string) => settlement(org, date),
    async closeDay(_t: string, org: string, date: string, counted: string, reason: string, op: string, confirmed: boolean) {
      return replay(`close:${op}`, () => {
        if (!confirmed || date > today) throw invalid('Invalid daily close');
        if (s.closes.some((c) => c.business_date === date)) throw conflict('Business day is closed');
        const snapshot = settlement(org, date);
        s.closes.push({ id: randomUUID(), business_date: date, version: 1, expected_cash: snapshot.expected_cash, counted_cash: counted, reason, closed_by: USER_ID, closed_at: stamp, adjustments: [] });
        bump('closings');
        return settlement(org, date);
      });
    },
    async adjustClose() { throw invalid('not used'); },
    async listTransactions(_t: string, _o: string, from?: string, to?: string, type?: string) {
      return copy(s.finance.filter((f) => (!from || f.transaction_date >= from) && (!to || f.transaction_date <= to) && (!type || f.transaction_type === type)));
    },
    async createTransaction(_t: string, org: string, input: Row) {
      const row = { id: randomUUID(), organization_id: org, created_by: USER_ID, ...input, amount: fix2(Number(input.amount)), created_at: stamp, updated_at: stamp };
      s.finance.push(row); bump('finance-manual');
      return copy(row);
    },
    async updateTransaction() { return null; },
    async summarize() { return { income_total: '0.00', expense_total: '0.00', net_total: '0.00', transaction_count: s.finance.length }; },
  };
  function settlement(org: string, date: string) {
    const dayReceipts = s.receipts.filter((r) => kst(Date.parse(r.received_at)).date === date);
    const sum = (method: string) => dayReceipts.filter((r) => r.method === method).reduce((n, r) => n + r.amount, 0);
    const refunded = (method: string) => s.refunds.filter((f) => kst(Date.parse(f.created_at)).date === date && s.receipts.find((r) => r.id === f.source_id)?.method === method).reduce((n, f) => n + f.amount, 0);
    const close = s.closes.find((c) => c.business_date === date);
    const whole = (n: number) => String(n);
    return copy({
      organization_id: org, business_date: date, cash_received: whole(sum('cash')), cash_refunded: whole(refunded('cash')), expected_cash: whole(sum('cash') - refunded('cash')),
      card_received: whole(sum('card')), card_refunded: whole(refunded('card')), transfer_received: whole(sum('transfer')), transfer_refunded: whole(refunded('transfer')),
      receipt_count: dayReceipts.length, refund_count: 0, receivables: [], is_closed: Boolean(close),
      close: close ? { id: close.id, version: 1, expected_cash: close.expected_cash, counted_cash: close.counted_cash, variance: '0', reason: close.reason, closed_by: USER_ID, closed_at: stamp, adjustments: [] } : null,
    });
  }
  const catalogGateway: any = {
    async listProducts() { return s.products.map(productRow); },
    async saveProduct(_t: string, org: string, productId: string | null, expected: number | null, op: string, values: Row) {
      return replay(`product:${op}`, () => {
        if (productId === null) {
          if (s.products.some((p) => p.sku === values.sku)) throw conflict('Sale cart conflict; reload before retrying');
          const row = { id: randomUUID(), organization_id: org, ...values, version: 1, stock_quantity: 0 };
          s.products.push(row); bump('products');
          return row;
        }
        const row = catalogProduct(productId);
        if (row.version !== expected) throw conflict('Product changed');
        Object.assign(row, values, { version: row.version + 1 });
        return productRow(row);
      });
    },
    async receiveStock(_t: string, _o: string, productId: string, quantity: number, reason: string, op: string) {
      return replay(`stock:${op}`, () => {
        const product = catalogProduct(productId);
        if (product.kind !== 'product') throw invalid('Invalid stock balance');
        product.stock_quantity += quantity; product.version += 1;
        s.ledger.push({ id: randomUUID(), organization_id: ORG_ID, product_id: productId, movement_kind: 'receipt', quantity, reason, created_by: USER_ID, created_at: stamp });
        bump('stock-receipts');
        return productRow(product);
      });
    },
    async changeStock(_t: string, _o: string, productId: string, kind: string, quantity: number, reason: string, expected: number, op: string) {
      return replay(`stock:${op}`, () => {
        const product = catalogProduct(productId);
        if (product.version !== expected) throw conflict('Product version conflict');
        const delta = kind === 'stocktake' ? quantity - product.stock_quantity : -quantity;
        if (product.stock_quantity + delta < 0) throw invalid('Invalid stock balance');
        if (delta !== 0) { product.stock_quantity += delta; product.version += 1; s.ledger.push({ id: randomUUID(), organization_id: ORG_ID, product_id: productId, movement_kind: kind, quantity: delta, reason, created_by: USER_ID, created_at: stamp }); bump('stock-adjustments'); }
        return productRow(product);
      });
    },
    async listStockLedger(_t: string, _o: string, productId: string) { return copy(s.ledger.filter((l) => l.product_id === productId)); },
    async addProductToCart(_t: string, org: string, visitId: string, productId: string, version: number, op: string) {
      return replay(`cart:${op}`, () => {
        const cart = cartOf(visitId); guardEditable(cart, version);
        const product = catalogProduct(productId);
        if (!product.is_active) throw conflict('Product is stopped');
        if (s.lines.some((l) => l.cart_id === cart.id && l.source_id === productId && l.status === 'active')) throw conflict('Product already active in this cart');
        s.lines.push({ id: randomUUID(), organization_id: org, cart_id: cart.id, source_type: product.kind, source_id: productId, description_snapshot: product.name, quantity: 1, returned_quantity: 0,
          unit_price: Number(product.sale_price), staff_id: null, staff_name_snapshot: '', source_snapshot: { id: productId, kind: product.kind }, status: 'active', removal_reason: '', created_at: stamp, removed_at: null });
        recalc(cart); return bundle(visitId);
      });
    },
    async listWallets(_t: string, _o: string, customerId: string) { return copy(s.wallets.filter((w) => w.customer_id === customerId).map((w) => ({ ...w, money_balance: String(w.money_balance) }))); },
    async manageWallet() { throw invalid('not used'); },
    async useWallet(_t: string, _o: string, visitId: string, walletId: string, lineId: string, mode: string, amount: string | null, version: number, op: string, confirmed: boolean) {
      return replay(`pay:${op}`, () => {
        const cart = cartOf(visitId); const visit = visitOf(visitId);
        if (!confirmed || cart.version !== version || !['ready', 'collecting'].includes(cart.status) || visit.status !== 'checkout_ready') throw conflict('Cart changed');
        const wallet = s.wallets.find((w) => w.id === walletId && w.customer_id === cart.customer_id);
        if (!wallet) throw missing('Wallet not found');
        const line = s.lines.find((l) => l.id === lineId && l.cart_id === cart.id && l.status === 'active' && l.source_type === 'treatment_draft');
        if (!line) throw invalid('Active treatment line required');
        const outstanding = cart.total_amount - grossPaid(cart.id) - walletApplied(cart.id);
        const lineRemaining = line.unit_price * line.quantity - s.walletUsages.filter((u) => u.sale_line_id === lineId).reduce((n, u) => n + u.applied, 0);
        if (outstanding <= 0 || lineRemaining <= 0) throw conflict('No remaining amount for wallet usage');
        let applied: number;
        if (mode === 'money') {
          applied = Number(amount);
          if (wallet.money_balance < applied || applied > outstanding || applied > lineRemaining) throw conflict('Insufficient wallet or applicable balance');
          wallet.money_balance -= applied;
        } else {
          if (wallet.count_balance < 1 || lineRemaining > outstanding || s.walletUsages.some((u) => u.sale_line_id === lineId && u.mode === 'count')) throw conflict('Count benefit is unavailable for this line');
          applied = lineRemaining; wallet.count_balance -= 1;
        }
        s.walletUsages.push({ id: randomUUID(), cart_id: cart.id, sale_line_id: lineId, mode, applied }); bump('wallet-usages');
        if (grossPaid(cart.id) + walletApplied(cart.id) === cart.total_amount) settle(cart); else Object.assign(cart, { status: 'collecting', version: cart.version + 1 });
        return paymentsPayload(visitId);
      });
    },
  };

  /* ---------- 문서·서식·동의서·파일 ---------- */
  const documentsGateway: any = {
    async listTemplates() { return copy(s.templates); },
    async mutateTemplate(_t: string, org: string, templateId: string, input: Row) {
      return replay(`tpl:${input.operation_id}`, () => {
        if (input.action === 'create') {
          if (s.templates.some((t) => t.id === templateId)) throw conflict('Template ID already exists');
          const row = { id: templateId, organization_id: org, created_by: USER_ID, name: input.values.name, description: input.values.description, content: input.values.content, is_archived: false, created_at: stamp, updated_at: stamp, status: 'draft', version: 1, revision: 1 };
          s.templates.push(row); bump('templates');
          return row;
        }
        const row = s.templates.find((t) => t.id === templateId);
        if (!row) throw missing('Template not found');
        if (row.revision !== input.expected_revision) throw conflict('Template changed; reload before retrying');
        if (input.action === 'publish') {
          if (row.status !== 'draft' || !row.content.trim()) throw conflict('Invalid template state transition');
          s.versions.push({ template_id: row.id, organization_id: org, version: row.version, name: row.name, description: row.description, content: row.content, published_by: USER_ID, published_at: stamp });
          row.status = 'published'; bump('template-publish');
        }
        row.revision += 1;
        return copy(row);
      });
    },
    async listTemplateVersions(_t: string, _o: string, id: string) { return copy(s.versions.filter((v) => v.template_id === id)); },
    async listDocuments() { return copy(s.documents); },
    async createDocument(_t: string, org: string, input: Row) { const row = { id: randomUUID(), organization_id: org, created_by: USER_ID, ...input, created_at: stamp, updated_at: stamp }; s.documents.push(row); bump('documents'); return copy(row); },
    async updateDocument(_t: string, _o: string, id: string, patch: Row) { const row = s.documents.find((d) => d.id === id); if (!row) return null; Object.assign(row, patch); return copy(row); },
    async previewTreatmentDocument(_t: string, scope: Row, templateId: string) { return renderDocument(scope, templateId); },
    async issueTreatmentDocument(_t: string, scope: Row, input: Row) {
      return replay(`issue:${input.operation_id}`, () => {
        const preview = renderDocument(scope, input.template_id);
        if (JSON.stringify(preview) !== JSON.stringify(input.expected_preview)) throw conflict('Preview changed; review again');
        if (preview.missing_fields.length > 0) throw invalid('Missing document fields');
        const row = { id: randomUUID(), organization_id: scope.organizationId, customer_id: scope.customerId, treatment_id: scope.treatmentId, template_id: preview.template_id, template_version: preview.template_version, title: preview.title, content: preview.content, source_snapshot: preview.source_snapshot, issued_by: USER_ID, issued_at: stamp };
        s.issued.push(row); bump('issued-documents');
        return row;
      });
    },
    async listIssuedTreatmentDocuments(_t: string, scope: Row) { return copy(s.issued.filter((d) => d.treatment_id === scope.treatmentId)); },
    async listConsentEvents(_t: string, _scope: Row, documentId: string) { return copy(s.events.filter((e) => e.document_id === documentId)); },
    async recordConsentEvent(_t: string, scope: Row, documentId: string, input: Row) {
      return replay(`consent:${input.operation_id}`, () => {
        if (!s.issued.some((d) => d.id === documentId)) throw missing('Issued document not found');
        const events = s.events.filter((e) => e.document_id === documentId);
        if (input.expected_revision !== events.length) throw conflict('Document evidence changed; reload');
        const signed = events.some((e) => e.action === 'sign');
        if (input.action === 'sign' && signed) throw invalid('Document already signed');
        if (input.action !== 'sign' && !signed) throw invalid('Signature required');
        const row = { id: randomUUID(), organization_id: scope.organizationId, document_id: documentId, revision: events.length + 1, action: input.action, values: input.values, actor_id: USER_ID, occurred_at: stamp, content_hash: 'hash' };
        s.events.push(row); bump(`consent-${input.action}`);
        return row;
      });
    },
    async listFiles(_t: string, _o: string, includeArchived: boolean) { return copy(s.files.filter((f) => includeArchived || !f.is_archived)); },
    async createFileUpload(_t: string, org: string, input: Row) {
      const row = { id: randomUUID(), organization_id: org, uploaded_by: USER_ID, original_name: input.original_name, content_type: input.content_type, size_bytes: input.size_bytes, is_archived: false, created_at: stamp, updated_at: stamp };
      s.files.push(row); bump('files');
      return { file: copy(row), signed_url: `https://storage.example.test/object/upload/sign/files/${row.id}?token=upload-secret`, expires_in: 600 };
    },
    async createFileDownload() { throw missing('File not found'); },
    async archiveFile(_t: string, _o: string, id: string) { const row = s.files.find((f) => f.id === id); if (!row) return null; row.is_archived = true; return copy(row); },
  };
  function renderDocument(scope: Row, templateId: string) {
    const treatment = s.treatments.find((t) => t.id === scope.treatmentId && t.customer_id === scope.customerId);
    const customer = customerOf(scope.customerId);
    if (!treatment || !customer) throw missing('Treatment not found');
    const template = s.templates.find((t) => t.id === templateId);
    const version = s.versions.find((v) => v.template_id === templateId && v.version === template?.version);
    if (!template || template.status !== 'published' || !version) throw invalid('Published template required');
    const fields: Record<string, string> = { 'customer.name': customer.name, 'customer.phone': customer.phone ?? '', 'customer.birth_date': customer.birth_date ?? '', 'treatment.name': treatment.treatment_name,
      'treatment.date': treatment.treatment_date, 'treatment.practitioner': treatment.practitioner, 'treatment.amount': treatment.amount ?? '', 'treatment.consultation_goal': treatment.consultation_goal };
    const missingFields: string[] = [];
    const content = version.content.replace(/\{\{([^{}]*)\}\}/g, (token: string, key: string) => { if (!fields[key]?.trim()) { if (!missingFields.includes(key)) missingFields.push(key); return token; } return fields[key]; });
    return { template_id: templateId, template_version: version.version, title: version.name, content, source_snapshot: { treatment: { id: treatment.id, version: treatment.version }, customer: { id: customer.id } }, missing_fields: missingFields };
  }

  /* ---------- Fastify 앱과 fetch 어댑터 ---------- */
  const app = Fastify({ logger: false });
  registerAuthRoutes(app, auth);
  registerOrganizationRoutes(app, organizations);
  registerCustomerRoutes(app, organizations, customers);
  registerTaskRoutes(app, organizations, tasks);
  registerAppointmentRoutes(app, organizations, appointmentsGateway);
  registerAppointmentResourceRoutes(app, organizations, resourcesGateway);
  registerTreatmentRoutes(app, organizations, treatmentsGateway);
  registerSaleDraftRoutes(app, organizations, saleDraftsGateway);
  registerSalesRoutes(app, organizations, salesGateway);
  registerCatalogRoutes(app, organizations, catalogGateway);
  registerDocumentRoutes(app, organizations, documentsGateway);
  app.setErrorHandler((error: any, request, reply) => {
    const status = error instanceof ApiFailure ? error.status : 500;
    return reply.code(status).send({ detail: error instanceof ApiFailure ? error.detail : 'Internal server error', ...(error instanceof ApiFailure ? error.extra : {}), requestId: request.id });
  });

  const requests: { method: string; path: string; status: number }[] = [];
  const fetchImpl = async (input: URL | string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = (init.method ?? 'GET').toUpperCase();
    const log = (status: number) => requests.push({ method, path: url.pathname, status });
    if (url.host === 'storage.example.test') {
      s.uploads.push(`${url.pathname}:${String(init.body ? (init.body as Uint8Array).length : 0)}`);
      log(200); return new Response(null, { status: 200 });
    }
    const injected = options.intercept?.(method, url.pathname);
    if (injected) { log(injected.status); return new Response(JSON.stringify(injected.body), { status: injected.status, headers: { 'content-type': 'application/json' } }); }
    const response = await app.inject({ method: method as any, url: url.pathname + url.search, headers: Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>)), payload: init.body as string | undefined });
    log(response.statusCode);
    return new Response(response.statusCode === 204 || response.statusCode === 304 ? null : response.body, { status: response.statusCode, headers: { 'content-type': String(response.headers['content-type'] ?? 'application/json') } });
  };

  return { fetch: fetchImpl as unknown as typeof fetch, store: s, created, requests, today, close: () => app.close() };
}
