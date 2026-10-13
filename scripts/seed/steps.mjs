// 단계별 시드 실행. 모든 쓰기는 Node API(=서버 RPC)를 거치며, 먼저 [데모] 표식 데이터를 조회해 이미 있으면 건너뛴다.
import { MARK, addDays, kstDateTime, seedUuid, wonOf, wonText, redact } from './util.mjs';
import { SeedHttpError } from './client.mjs';
import { STEP_META, STEP_ORDER, TREATMENT_ACTIONS } from './plan.mjs';

const SIGNATURE_STROKES = [
  [[0.1, 0.3], [0.25, 0.6], [0.4, 0.35], [0.55, 0.7], [0.8, 0.4]],
  [[0.2, 0.8], [0.7, 0.85]],
];

/** 단계가 쓰는 짧은 API 도우미(조직 경로 포함). */
function api(ctx) {
  const path = (rest) => `/organizations/${ctx.orgId}${rest}`;
  return {
    get: (rest, query) => ctx.client.get(path(rest), query),
    post: (rest, body, query) => ctx.client.post(path(rest), body, query),
    put: (rest, body) => ctx.client.put(path(rest), body),
    patch: (rest, body) => ctx.client.patch(path(rest), body),
    del: (rest) => ctx.client.del(path(rest)),
  };
}

/** 선행 단계 결과가 없으면 사람이 이해할 수 있는 오류로 알린다. */
function need(list, index, label) {
  const value = list?.[index];
  if (!value) throw new Error(`선행 데이터가 없습니다: ${label} #${index + 1}`);
  return value;
}
const byName = (rows) => new Map(rows.map((row) => [row.name ?? row.title, row]));

/* ---------------- 고객 · 할 일 ---------------- */

async function customers(ctx) {
  const a = api(ctx);
  const existing = byName(await a.get('/customers'));
  ctx.state.customers = [];
  for (const spec of ctx.plan.customers) {
    let row = existing.get(spec.name);
    if (row) ctx.existed('고객');
    else { row = await a.post('/customers', spec.body); ctx.created('고객'); }
    ctx.state.customers.push(row);
  }
}

async function tasks(ctx) {
  const a = api(ctx);
  const existing = byName(await a.get('/tasks'));
  for (const spec of ctx.plan.tasks) {
    if (existing.has(spec.title)) { ctx.existed('할일'); continue; }
    const row = await a.post('/tasks', spec.body);
    ctx.created('할일');
    if (spec.status !== 'open') await a.patch(`/tasks/${row.id}`, { status: spec.status });
  }
}

/* ---------------- 예약 자원 ---------------- */

async function staff(ctx) {
  const a = api(ctx);
  const existing = byName(await a.get('/appointment-staff'));
  ctx.state.staff = [];
  for (const [index, spec] of ctx.plan.staff.entries()) {
    let row = existing.get(spec.name);
    let availability = null;
    if (row) { ctx.existed('담당자'); availability = await a.get(`/appointment-staff/${row.id}/availability`); }
    else { row = await a.post('/appointment-staff', { name: spec.name }); ctx.created('담당자'); }
    if (availability && availability.hours.length > 0) ctx.existed('근무시간');
    else {
      await a.put(`/appointment-staff/${row.id}/working-hours`, {
        timezone_name: 'Asia/Seoul', hours: spec.hours, expected_version: availability?.schedule_version ?? row.schedule_version ?? 1, operation_id: ctx.uid(`staff:${index}:hours`),
      });
      ctx.created('근무시간');
    }
    ctx.state.staff.push(row);
    for (const [offIndex, off] of ctx.plan.timeOff.entries()) {
      if (off.staffIndex !== index) continue;
      if (availability?.time_off?.some((item) => item.reason === off.reason)) { ctx.existed('휴무'); continue; }
      await a.post(`/appointment-staff/${row.id}/time-off`, {
        start_at: kstDateTime(off.date, off.start), end_at: kstDateTime(off.date, off.end), reason: off.reason, operation_id: ctx.uid(`staff:${index}:timeoff:${offIndex}`),
      });
      ctx.created('휴무');
    }
  }
}

async function services(ctx) {
  const a = api(ctx);
  const existing = byName(await a.get('/appointment-services'));
  ctx.state.services = [];
  for (const spec of ctx.plan.services) {
    let row = existing.get(spec.name);
    if (row) ctx.existed('서비스');
    else { row = await a.post('/appointment-services', { name: spec.name, duration_minutes: spec.duration_minutes, buffer_minutes: spec.buffer_minutes }); ctx.created('서비스'); }
    ctx.state.services.push(row);
  }
}

async function resources(ctx) {
  const a = api(ctx);
  const existing = byName(await a.get('/appointment-resources'));
  ctx.state.resources = { rooms: [], equipment: [] };
  for (const [index, spec] of ctx.plan.resources.entries()) {
    let row = existing.get(spec.name);
    if (row) ctx.existed(spec.kind === 'room' ? '공간' : '장비');
    else { row = await a.post('/appointment-resources', { name: spec.name, kind: spec.kind, operation_id: ctx.uid(`resource:${index}`) }); ctx.created(spec.kind === 'room' ? '공간' : '장비'); }
    ctx.state.resources[spec.kind === 'room' ? 'rooms' : 'equipment'].push(row);
  }
}

async function requirements(ctx) {
  const a = api(ctx);
  for (const [index, spec] of ctx.plan.services.entries()) {
    const service = need(ctx.state.services, index, '서비스');
    const setup = await a.get(`/appointment-services/${service.id}/resource-setup`);
    if (setup.requirements.length > 0) { ctx.existed('기준'); continue; }
    await a.put(`/appointment-services/${service.id}/resource-requirements`, { requirements: spec.requirements, expected_version: setup.resource_version, operation_id: ctx.uid(`service:${index}:requirements`) });
    ctx.created('기준');
  }
}

/** 목표 상태 경로에서 현재 상태 이후에 남은 전이만 돌려준다. */
export function remainingChain(chain, status) {
  if (chain.length === 0) return [];
  if (status === 'reserved') return chain;
  const position = chain.indexOf(status);
  return position >= 0 ? chain.slice(position + 1) : [];
}

async function appointments(ctx) {
  const a = api(ctx);
  const rows = await a.get('/appointments', { from_date: addDays(ctx.plan.today, -300), to_date: addDays(ctx.plan.today, 60) });
  for (const spec of ctx.plan.appointments) {
    const customer = need(ctx.state.customers, spec.customer, '고객');
    const staffRow = need(ctx.state.staff, spec.staff, '담당자');
    const service = need(ctx.state.services, spec.service, '서비스');
    let row = rows.find((item) => item.customer_id === customer.id && item.service_id === service.id);
    if (row) ctx.existed('예약');
    else {
      const rooms = ctx.state.resources.rooms;
      const equipment = ctx.state.resources.equipment;
      const resourceIds = [need(rooms, spec.index % 5, '공간').id];
      if (ctx.plan.services[spec.service].requirements.some((item) => item.kind === 'equipment')) resourceIds.push(need(equipment, spec.index % 5, '장비').id);
      row = await a.post('/appointments', {
        customer_id: customer.id, staff_id: staffRow.id, service_id: service.id, start_at: kstDateTime(spec.date, spec.time), source: spec.source,
        operation_id: ctx.uid(`appointment:${spec.index}`), resource_ids: resourceIds,
      });
      ctx.created('예약');
    }
    for (const target of remainingChain(spec.chain, row.status)) {
      row = await a.post(`/appointments/${row.id}/transitions`, {
        target_status: target, reason: target === 'canceled' ? spec.reason : null, expected_version: row.version, operation_id: ctx.uid(`appointment:${spec.index}:${target}`),
      });
      ctx.created('상태전이');
    }
  }
}

/* ---------------- 시술 · 판매 초안 ---------------- */

const consultDone = (row) => String(row.consultation_goal ?? '').trim() !== '' && Boolean(row.cautions_acknowledged_at);
const actionDone = {
  consult: (row) => consultDone(row) || row.status !== 'draft',
  start: (row) => ['in_progress', 'completed', 'cancelled'].includes(row.status),
  complete: (row) => row.status === 'completed',
  cancel: (row) => row.status === 'cancelled',
};

async function treatments(ctx) {
  const a = api(ctx);
  ctx.state.treatments = [];
  for (const spec of ctx.plan.treatments) {
    const customer = need(ctx.state.customers, spec.customer, '고객');
    const list = await a.get(`/customers/${customer.id}/treatments`);
    let row = list.find((item) => item.treatment_name === spec.body.treatment_name);
    if (row) ctx.existed('시술');
    else { row = await a.post(`/customers/${customer.id}/treatments`, spec.body); ctx.created('시술'); }
    for (const action of TREATMENT_ACTIONS[spec.target]) {
      if (row.status === 'legacy' || actionDone[action](row)) continue;
      const mutation = { action, expected_version: row.version, operation_id: ctx.uid(`treatment:${spec.index}:${action}`), reason: action === 'cancel' ? `${MARK} 고객 피부 상태 악화로 시술 중단` : '' };
      if (action === 'consult') {
        mutation.values = {
          goal: `${MARK} 피부 컨디션 개선과 관리 계획 상담`, plan: `${MARK} 주 1회 관리, 홈케어 병행`, acknowledge_cautions: true,
          expected_cautions: { allergies: customer.allergies ?? '', skin_type: customer.skin_type ?? null, concerns: customer.concerns ?? [] },
        };
      }
      row = await a.post(`/customers/${customer.id}/treatments/${row.id}/mutations`, mutation);
      ctx.created('상태전이');
    }
    ctx.state.treatments.push(row);
  }
}

async function saleDrafts(ctx) {
  const a = api(ctx);
  ctx.state.drafts = new Map();
  for (const spec of ctx.plan.saleDrafts) {
    const treatment = need(ctx.state.treatments, spec.treatment, '시술');
    const customer = need(ctx.state.customers, spec.treatment, '고객');
    const base = `/customers/${customer.id}/treatments/${treatment.id}/sale-draft`;
    const current = await a.get(base);
    if (current.length > 0) { ctx.existed('판매초안'); ctx.state.drafts.set(spec.treatment, current[0]); continue; }
    if (!['completed', 'cancelled'].includes(treatment.status)) throw new Error(`시술 #${spec.treatment + 1}이 완료·중단 상태가 아니어서 판매 초안을 만들 수 없습니다.`);
    const preview = await a.post(`${base}/preview`, { values: spec.values });
    const draft = await a.post(base, { operation_id: ctx.uid(`saledraft:${spec.treatment}`), expected_preview: preview, confirmed: true });
    ctx.created('판매초안');
    ctx.state.drafts.set(spec.treatment, draft);
  }
}

/* ---------------- 상품 · 재고 ---------------- */

async function products(ctx) {
  const a = api(ctx);
  const rows = await a.get('/catalog-products');
  ctx.state.products = [];
  for (const [index, spec] of ctx.plan.products.entries()) {
    let row = rows.find((item) => item.sku === spec.sku);
    if (row) ctx.existed(spec.kind === 'product' ? '상품' : '회원권');
    else { row = await a.post('/catalog-products', { operation_id: ctx.uid(`product:${index}`), ...spec.body }); ctx.created(spec.kind === 'product' ? '상품' : '회원권'); }
    ctx.state.products.push(row);
  }
}

async function inventory(ctx) {
  const a = api(ctx);
  const productFor = (sku) => ctx.state.products.find((item) => item.sku === sku);
  for (const [index, spec] of ctx.plan.products.entries()) {
    if (spec.kind !== 'product') continue;
    const product = need(ctx.state.products, index, '상품');
    const reason = `${MARK} 초도 입고`;
    const ledger = await a.get(`/catalog-products/${product.id}/stock-ledger`);
    if (ledger.some((item) => item.reason === reason)) { ctx.existed('입고'); continue; }
    ctx.state.products[index] = await a.post(`/catalog-products/${product.id}/stock-receipts`, { operation_id: ctx.uid(`stock:${spec.sku}:receipt`), quantity: ctx.plan.receipts[spec.sku], reason });
    ctx.created('입고');
  }
  for (const [index, adjustment] of ctx.plan.stockAdjustments.entries()) {
    const product = need([productFor(adjustment.sku)], 0, `상품 ${adjustment.sku}`);
    const ledger = await a.get(`/catalog-products/${product.id}/stock-ledger`);
    if (ledger.some((item) => item.reason === adjustment.reason)) { ctx.existed('재고조정'); continue; }
    const fresh = (await a.get('/catalog-products')).find((item) => item.id === product.id) ?? product;
    const updated = await a.post(`/catalog-products/${product.id}/stock-adjustments`, { operation_id: ctx.uid(`stock:adjust:${index}`), kind: adjustment.kind, quantity: adjustment.quantity, reason: adjustment.reason, expected_version: fresh.version });
    ctx.state.products[ctx.state.products.findIndex((item) => item.id === product.id)] = updated;
    ctx.created('재고조정');
  }
}

/* ---------------- 방문 · 수납 · 환불 · 반품 · 회원권 ---------------- */

async function sales(ctx) {
  const a = api(ctx);
  const visitCache = new Map();
  const visitsOf = async (customer) => {
    if (!visitCache.has(customer.id)) {
      const rows = await a.get('/visits', { customer_id: customer.id });
      // 예약 체크인으로 자동 생긴 방문은 흐름 판정에서 뺀다.
      visitCache.set(customer.id, rows.filter((visit) => !visit.appointment_id).sort((x, y) => String(x.opened_at).localeCompare(String(y.opened_at))));
    }
    return visitCache.get(customer.id);
  };
  const productBySku = (sku) => need([ctx.state.products?.find((item) => item.sku === sku)], 0, `상품 ${sku}`);
  const draftOf = (treatment) => need([ctx.state.drafts?.get(treatment)], 0, `판매 초안(시술 #${treatment + 1})`);

  const flow = (key) => ({
    open: async (customer) => { const bundle = await a.post(`/customers/${customer.id}/visits`, { operation_id: ctx.uid(`sales:${key}:visit`) }); ctx.created('방문'); return bundle; },
    addDraft: (b, draftId) => a.post(`/visits/${b.visit.id}/sale-cart/lines/treatment-draft`, { operation_id: ctx.uid(`sales:${key}:draft`), expected_version: b.cart.version, draft_id: draftId }),
    addProduct: (b, productId, tag) => a.post(`/visits/${b.visit.id}/sale-cart/lines/catalog-product`, { operation_id: ctx.uid(`sales:${key}:product:${tag}`), expected_version: b.cart.version, product_id: productId }),
    quantity: (b, lineId, quantity) => a.patch(`/visits/${b.visit.id}/sale-cart/lines/${lineId}`, { operation_id: ctx.uid(`sales:${key}:quantity`), expected_version: b.cart.version, quantity }),
    discount: async (b, kind, value, reason) => { const next = await a.post(`/visits/${b.visit.id}/sale-cart/discount`, { operation_id: ctx.uid(`sales:${key}:discount`), expected_version: b.cart.version, kind, value, reason, confirmed: true }); ctx.created('할인'); return next; },
    ready: (b) => a.post(`/visits/${b.visit.id}/sale-cart/review`, { operation_id: ctx.uid(`sales:${key}:ready`), expected_version: b.cart.version, ready: true }),
    pay: async (visitId, version, parts, tag = 'pay') => {
      const result = await a.post(`/visits/${visitId}/payments`, { operation_id: ctx.uid(`sales:${key}:${tag}`), expected_version: version, payments: parts, confirmed: true });
      ctx.created('수납', parts.length);
      return result;
    },
    wallet: async (customer, productId) => {
      const wallets = await a.get(`/customers/${customer.id}/wallets`);
      return need([wallets.find((item) => item.product_id === productId)], 0, '고객 지갑');
    },
  });
  const line = (b, predicate, label) => need([b.lines.find((item) => item.status === 'active' && predicate(item))], 0, label);
  const card = (amount, tag) => ({ method: 'card', amount: String(amount), reference: `${MARK}-승인-${tag}` });
  const transfer = (amount, tag) => ({ method: 'transfer', amount: String(amount), reference: `${MARK}-이체-${tag}` });
  const cash = (amount) => ({ method: 'cash', amount: String(amount), reference: '' });

  const flows = {
    async f1(customer) {
      const f = flow('f1');
      let b = await f.open(customer);
      b = await f.addDraft(b, draftOf(0).id);
      b = await f.ready(b);
      const total = wonOf(b.cart.total_amount);
      const paid = await f.pay(b.visit.id, b.cart.version, [cash(50000), card(total - 50000, 'F1')]);
      const receipt = paid.receipts.find((item) => item.method === 'card');
      await a.post(`/visits/${b.visit.id}/payments/refunds`, { operation_id: ctx.uid('sales:f1:refund'), expected_version: paid.cart_version, source_id: receipt.id, amount: '20000', reason: `${MARK} 시술 만족도 불만으로 일부 환불`, confirmed: true });
      ctx.created('환불');
    },
    async f2(customer) {
      const f = flow('f2');
      let b = await f.open(customer);
      b = await f.addDraft(b, draftOf(1).id);
      b = await f.discount(b, 'percent', '10', `${MARK} 재방문 고객 10% 할인`);
      b = await f.ready(b);
      const total = wonOf(b.cart.total_amount);
      await f.pay(b.visit.id, b.cart.version, [card(40000, 'F2'), transfer(total - 40000, 'F2')]);
    },
    async f3(customer) {
      const f = flow('f3');
      const first = productBySku('DEMO-P01');
      const second = productBySku('DEMO-P02');
      let b = await f.open(customer);
      b = await f.addProduct(b, first.id, 'a');
      b = await f.addProduct(b, second.id, 'b');
      b = await f.quantity(b, line(b, (item) => item.source_id === second.id, '상품 판매 줄').id, 2);
      b = await f.ready(b);
      const total = wonOf(b.cart.total_amount);
      const paid = await f.pay(b.visit.id, b.cart.version, [cash(30000), card(total - 30000, 'F3')]);
      const target = line(b, (item) => item.source_id === second.id, '반품할 판매 줄');
      const receipt = paid.receipts.find((item) => item.method === 'card');
      await a.post(`/visits/${b.visit.id}/payments/product-returns`, {
        operation_id: ctx.uid('sales:f3:return'), expected_version: paid.cart_version, sale_line_id: target.id, receipt_id: receipt.id, quantity: 1, restock: true,
        amount: wonText(wonOf(target.unit_price)), reason: `${MARK} 고객 변심으로 1개 반품`, confirmed: true,
      });
      ctx.created('반품');
    },
    async f4(customer) {
      const f = flow('f4');
      let b = await f.open(customer);
      b = await f.addProduct(b, productBySku('DEMO-M01').id, 'm');
      b = await f.ready(b);
      await f.pay(b.visit.id, b.cart.version, [card(wonOf(b.cart.total_amount), 'F4')]);
      ctx.created('회원권 지갑');
    },
    async f5(customer) {
      const f = flow('f5');
      const wallet = await f.wallet(customer, productBySku('DEMO-M01').id);
      let b = await f.open(customer);
      b = await f.addDraft(b, draftOf(3).id);
      b = await f.ready(b);
      const target = line(b, (item) => item.source_type === 'treatment_draft', '시술 줄');
      const used = await a.post(`/visits/${b.visit.id}/wallet-usages`, { operation_id: ctx.uid('sales:f5:wallet'), wallet_id: wallet.id, sale_line_id: target.id, mode: 'money', amount: '100000', expected_cart_version: b.cart.version, confirmed: true });
      ctx.created('지갑 사용');
      await f.pay(b.visit.id, used.cart_version, [cash(wonOf(used.outstanding_amount))]);
    },
    async f6a(customer) {
      const f = flow('f6a');
      let b = await f.open(customer);
      b = await f.addProduct(b, productBySku('DEMO-M02').id, 'm');
      b = await f.ready(b);
      await f.pay(b.visit.id, b.cart.version, [cash(wonOf(b.cart.total_amount))]);
      ctx.created('회원권 지갑');
    },
    async f6b(customer) {
      const f = flow('f6b');
      const wallet = await f.wallet(customer, productBySku('DEMO-M02').id);
      let b = await f.open(customer);
      b = await f.addDraft(b, draftOf(4).id);
      b = await f.ready(b);
      const target = line(b, (item) => item.source_type === 'treatment_draft', '시술 줄');
      await a.post(`/visits/${b.visit.id}/wallet-usages`, { operation_id: ctx.uid('sales:f6b:wallet'), wallet_id: wallet.id, sale_line_id: target.id, mode: 'count', expected_cart_version: b.cart.version, confirmed: true });
      ctx.created('지갑 사용');
    },
    async f7(customer) {
      const f = flow('f7');
      let b = await f.open(customer);
      b = await f.addDraft(b, draftOf(5).id);
      b = await f.ready(b);
      await f.pay(b.visit.id, b.cart.version, [cash(80000)]);
    },
  };

  for (const spec of ctx.plan.flows) {
    const customer = need(ctx.state.customers, spec.customer, '고객');
    const found = (await visitsOf(customer))[spec.nth - 1];
    if (found && spec.done.includes(found.status)) { ctx.existed('방문흐름'); continue; }
    await flows[spec.key](customer);
    ctx.created('방문흐름');
    visitCache.delete(customer.id);
  }
}

async function closing(ctx) {
  const a = api(ctx);
  const date = ctx.plan.closeDate;
  const settlement = await a.get('/sale-daily-settlement', { business_date: date });
  if (settlement.is_closed) { ctx.existed('일마감'); return; }
  const expected = wonOf(settlement.expected_cash);
  await a.post('/sale-daily-settlement/close', {
    operation_id: ctx.uid(`closing:${date}`), counted_cash: String(Math.max(0, expected)), reason: `${MARK} 과거 영업일(${date}) 시재 마감`, confirmed: true,
  }, { business_date: date });
  ctx.created('일마감');
}

/* ---------------- 수입·지출 ---------------- */

async function finance(ctx) {
  const a = api(ctx);
  const existing = new Set((await a.get('/finance-transactions')).map((row) => row.memo));
  for (const spec of ctx.plan.finance) {
    if (existing.has(spec.body.memo)) { ctx.existed('거래'); continue; }
    await a.post('/finance-transactions', spec.body);
    ctx.created('거래');
  }
}

/* ---------------- 문서 · 서식 · 동의서 · 파일 ---------------- */

async function templates(ctx) {
  const a = api(ctx);
  const existing = byName(await a.get('/document-templates'));
  ctx.state.templates = [];
  for (const [index, spec] of ctx.plan.templates.entries()) {
    let row = existing.get(spec.name);
    if (row) ctx.existed('서식');
    else {
      row = await a.post(`/document-templates/${ctx.uid(`template:${index}`)}/mutations`, {
        operation_id: ctx.uid(`template:${index}:create`), expected_revision: 0, action: 'create', values: { name: spec.name, description: spec.description, content: spec.content },
      });
      ctx.created('서식');
    }
    if (spec.publish && row.status === 'draft') {
      row = await a.post(`/document-templates/${row.id}/mutations`, { operation_id: ctx.uid(`template:${index}:publish`), expected_revision: row.revision ?? 1, action: 'publish' });
      ctx.created('발행');
    }
    ctx.state.templates.push(row);
  }
}

async function documents(ctx) {
  const a = api(ctx);
  const existing = new Set((await a.get('/documents')).map((row) => row.title));
  for (const spec of ctx.plan.documents) {
    if (existing.has(spec.title)) { ctx.existed('문서'); continue; }
    const template = spec.template === null ? null : need(ctx.state.templates, spec.template, '서식').id;
    await a.post('/documents', { title: spec.title, content: spec.content, template_id: template, status: spec.status });
    ctx.created('문서');
  }
}

async function consents(ctx) {
  const a = api(ctx);
  for (const [index, spec] of ctx.plan.consents.entries()) {
    const treatment = need(ctx.state.treatments, spec.treatment, '시술');
    const customer = need(ctx.state.customers, spec.treatment, '고객');
    const template = need(ctx.state.templates, spec.template, '서식');
    const base = `/customers/${customer.id}/treatments/${treatment.id}/documents`;
    let issued = (await a.get(base)).find((item) => item.template_id === template.id);
    if (issued) ctx.existed('시술문서');
    else {
      const preview = await a.post(`${base}/preview`, { template_id: template.id });
      issued = await a.post(base, { template_id: template.id, operation_id: ctx.uid(`consent:${index}:issue`), expected_preview: preview });
      ctx.created('시술문서');
    }
    if (!spec.sign) continue;
    let events = await a.get(`${base}/${issued.id}/events`);
    if (events.some((event) => event.action === 'sign')) ctx.existed('서명');
    else {
      const signed = await a.post(`${base}/${issued.id}/events`, {
        expected_revision: events.length, operation_id: ctx.uid(`consent:${index}:sign`), action: 'sign', values: { confirmed: true, signer_name: customer.name, strokes: SIGNATURE_STROKES },
      });
      events = [...events, signed];
      ctx.created('서명');
    }
    if (!spec.deliver) continue;
    if (events.some((event) => event.action === 'deliver')) ctx.existed('교부');
    else {
      await a.post(`${base}/${issued.id}/events`, {
        expected_revision: events.length, operation_id: ctx.uid(`consent:${index}:deliver`), action: 'deliver',
        values: { confirmed: true, method: 'paper', recipient: customer.name, reference: '', note: `${MARK} 종이 사본 교부` },
      });
      ctx.created('교부');
    }
  }
}

/** 서명 업로드 주소는 https(또는 로컬 개발 주소)만 허용한다. */
export function isSafeUploadUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch { return false; }
}

async function files(ctx) {
  const a = api(ctx);
  const existing = new Set((await a.get('/files')).map((row) => row.original_name));
  for (const spec of ctx.plan.files) {
    if (existing.has(spec.original_name)) { ctx.existed('파일'); continue; }
    const prepared = await a.post('/files/upload-url', { original_name: spec.original_name, content_type: spec.content_type, size_bytes: spec.bytes.length });
    try {
      if (!isSafeUploadUrl(prepared.signed_url)) throw new Error('업로드 주소가 안전하지 않아 중단했습니다.');
      await ctx.client.putBinary(prepared.signed_url, spec.bytes, spec.content_type);
    } catch (error) {
      // 올리지 못한 메타데이터가 목록에 남지 않도록 보관 처리한다.
      await a.del(`/files/${prepared.file.id}`).catch(() => undefined);
      throw error;
    }
    ctx.created('파일');
  }
}

export const STEPS = { customers, tasks, staff, services, resources, requirements, appointments, treatments, saleDrafts, products, inventory, sales, closing, finance, templates, documents, consents, files };

/* ---------------- 실행기 ---------------- */

function describe(error, secrets) {
  if (error instanceof SeedHttpError) {
    const where = `${error.method} ${String(error.path).replace(/^\/organizations\/[^/]+/, '')}`.trim();
    const head = error.status ? `HTTP ${error.status}` : '연결 실패';
    return redact(`${head}${error.detail ? ` ${error.detail}` : ''}${where ? ` (${where})` : ''}`, secrets);
  }
  return redact(error instanceof Error ? error.message : String(error), secrets);
}

const countText = (counts) => Object.entries(counts).map(([label, n]) => `${label} ${n}`).join(', ');

/**
 * 선택된 단계를 순서대로 실행한다. 한 단계가 실패해도 선행 관계가 없는 다른 단계는 계속한다.
 * 반환: 단계별 { key, status: ok|skipped|failed, created, existed, note }
 */
export async function runSteps(ctx, keys) {
  const results = new Map();
  for (const key of keys) {
    const meta = STEP_META[key];
    const stat = { created: {}, existed: {} };
    ctx.created = (label, n = 1) => { stat.created[label] = (stat.created[label] ?? 0) + n; };
    ctx.existed = (label, n = 1) => { stat.existed[label] = (stat.existed[label] ?? 0) + n; };
    const finish = (status, note = '') => {
      const result = { key, label: meta.label, status, created: stat.created, existed: stat.existed, note };
      results.set(key, result);
      ctx.out(`  ${status === 'ok' ? '완료' : status === 'skipped' ? '건너뜀' : '실패'} ${key} - ${meta.label}${note ? `: ${note}` : ''}`);
    };
    const blocked = meta.needs.filter((need) => results.get(need)?.status !== 'ok');
    if (blocked.length > 0) { finish('skipped', `선행 단계가 완료되지 않음: ${blocked.join(', ')}`); continue; }
    const missing = ctx.features ? meta.features.filter((feature) => !ctx.features.has(feature)) : [];
    if (missing.length > 0) { finish('skipped', `이 매장 구독에 기능이 없음: ${missing.join(', ')}`); continue; }
    try {
      await STEPS[key](ctx);
      finish('ok', countText(stat.created) === '' && countText(stat.existed) !== '' ? '모두 이미 있음' : '');
    } catch (error) {
      if (error instanceof SeedHttpError && error.status === 403 && error.featureCode) finish('skipped', `이 매장 구독에 기능이 없음: ${error.featureCode}`);
      else finish('failed', describe(error, ctx.secrets));
    }
  }
  return STEP_ORDER.filter((key) => results.has(key)).map((key) => ({ ...results.get(key), createdText: countText(results.get(key).created), existedText: countText(results.get(key).existed) }));
}

export { seedUuid };
