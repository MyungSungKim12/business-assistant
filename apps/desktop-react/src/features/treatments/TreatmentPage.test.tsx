import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { ApiError } from '../../api/errors';
import { TreatmentPage } from './TreatmentPage';
import { SaleDraftInboxDialog } from './SaleDraftDialog';
import type { Treatment } from './schemas';

const org = '22222222-2222-4222-8222-222222222222';
const cust = '11111111-1111-4111-8111-111111111111';
const other = '33333333-3333-4333-8333-333333333333';
const t1 = '44444444-4444-4444-8444-444444444444';
const t2 = '55555555-5555-4555-8555-555555555555';
const actor = '66666666-6666-4666-8666-666666666666';
const doc = '77777777-7777-4777-8777-777777777777';

const customer = (id: string, name: string, extra: object = {}) => ({ id, organization_id: org, name, email: null, phone: '010-1234-5678', notes: '', birth_date: null, skin_type: '건성', concerns: ['건조'], allergies: '향료', last_visit_date: null, next_visit_date: null, tags: [], status: 'active', ...extra });
const treatment = (id: string, extra: Partial<Treatment> = {}): Treatment => ({
  id, organization_id: org, customer_id: cust, treatment_date: '2026-09-18', treatment_name: '수분 관리', category: '피부', practitioner: '김담당', notes: '보습 위주', amount: '15000.50',
  next_visit_date: null, status: 'draft', version: 1, started_at: null, ended_at: null, consultation_goal: '', consultation_plan: '', cautions_snapshot: {}, cautions_acknowledged_by: null, cautions_acknowledged_at: null, appointment_service_id: null, ...extra,
});
const cautions = { allergies: '향료', skin_type: '건성', concerns: ['건조'] };
const readyRecord = (id = t1) => treatment(id, { consultation_goal: '보습', cautions_snapshot: cautions, cautions_acknowledged_by: actor, cautions_acknowledged_at: '2026-09-20T01:00:00Z' });

type Call = { method: string; path: string; body: unknown };
type Handler = (call: Call, state: { records: Treatment[] }) => unknown | undefined;

function setup(options: { records?: Treatment[]; handler?: Handler; customers?: object[]; listCustomers?: () => Promise<object[]>; photos?: object[] } = {}) {
  const state = { records: options.records ?? [treatment(t1)] };
  const calls: Call[] = [];
  const call = vi.fn(async (method: string, path: string, schema: z.ZodType, body?: unknown) => {
    const entry = { method, path, body };
    calls.push(entry);
    const custom = options.handler?.(entry, state);
    if (custom !== undefined) return schema.parse(custom);
    if (method === 'GET' && path.endsWith('/treatments')) return schema.parse(state.records);
    if (method === 'POST' && path.endsWith('/treatments')) {
      const created = treatment(other, { ...(body as object), id: '88888888-8888-4888-8888-888888888888' } as Partial<Treatment>);
      state.records = [...state.records, created];
      return schema.parse(created);
    }
    if (method === 'POST' && path.endsWith('/mutations')) {
      const request = body as { action: string; expected_version: number; values: Record<string, unknown> | null; reason: string };
      const id = path.split('/treatments/')[1].split('/')[0];
      const current = state.records.find((item) => item.id === id)!;
      if (current.version !== request.expected_version) throw new ApiError(409, 'HTTP_409', 'conflict', false);
      const next: Treatment = { ...current, version: current.version + 1 };
      if (request.action === 'start') Object.assign(next, { status: 'in_progress', started_at: '2026-09-21T01:00:00Z' });
      if (request.action === 'complete') Object.assign(next, { status: 'completed', ended_at: '2026-09-21T02:00:00Z' });
      if (request.action === 'cancel') Object.assign(next, { status: 'cancelled', ended_at: '2026-09-21T02:00:00Z' });
      if (request.action === 'edit' || request.action === 'correct') Object.assign(next, request.values);
      if (request.action === 'consult') {
        const values = request.values as { goal: string; plan: string; acknowledge_cautions: boolean; expected_cautions: Record<string, unknown> };
        Object.assign(next, { consultation_goal: values.goal, consultation_plan: values.plan, ...(values.acknowledge_cautions ? { cautions_snapshot: values.expected_cautions, cautions_acknowledged_by: actor, cautions_acknowledged_at: '2026-09-21T00:00:00Z' } : {}) });
      }
      state.records = state.records.map((item) => (item.id === id ? next : item));
      return schema.parse(next);
    }
    if (method === 'GET' && path.endsWith('/events')) return schema.parse([]);
    if (method === 'GET' && path.endsWith('/sale-draft')) return schema.parse([]);
    if (method === 'GET' && path.endsWith('/documents')) return schema.parse([{ id: doc, title: '시술 동의서', template_version: 2 }]);
    throw new ApiError(404, 'HTTP_404', 'not found', false);
  });
  const api = {
    listCustomers: vi.fn(options.listCustomers ?? (async () => options.customers ?? [customer(cust, '김고객'), customer(other, '박고객', { phone: null, allergies: '', skin_type: null, concerns: [] })])),
    listCustomerPhotos: vi.fn(async () => options.photos ?? []),
    createPhotoDownloadUrl: vi.fn(async (_o: string, _c: string, id: string) => ({ photo: {}, signed_url: `https://files.test/${id}`, expires_in: 60 })),
    filePlatform: { downloadBinary: vi.fn(async () => new Uint8Array([1, 2, 3])), pickImages: vi.fn(async () => []) },
    call,
    callVoid: vi.fn(),
  } as never;
  const view = (readOnly = false) => render(<><TreatmentPage api={api} organizationId={org} readOnly={readOnly} /><ConfirmDialog /></>);
  return { api, calls, state, view };
}

const pick = (calls: Call[], suffix: string, method = 'POST') => calls.filter((entry) => entry.method === method && entry.path.endsWith(suffix));
const click = (name: string | RegExp) => fireEvent.click(screen.getByRole('button', { name }));
const change = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const openRecord = async (name = '수분 관리') => { fireEvent.click(await screen.findByText(name)); await waitFor(() => expect(screen.getByLabelText('시술명 *')).toHaveValue(name)); };

describe('TreatmentPage', () => {
  it('예약에서 다시 열면 연결된 개별 시술을 선택하고 입력 중 연결 창은 막는다',async()=>{
    const {api,calls}=setup({records:[treatment(t1,{appointment_id:doc,visit_id:t2})]});
    render(<TreatmentPage api={api} organizationId={org} readOnly={false} initialCustomerId={cust} initialAppointmentId={doc}/>);
    await waitFor(()=>expect(screen.getByLabelText('시술명 *')).toHaveValue('수분 관리'));
    expect(screen.getByText(`연결 예약 ID: ${doc} · 방문 ID: ${t2}`)).toBeInTheDocument();
    expect(calls.every(call=>call.method==='GET')).toBe(true);
    change('시술명 *','작성 중');expect(screen.getByRole('button',{name:'예약·방문 연결'})).toBeDisabled();
  });
  it('예약에서 전달한 고객의 시술 이력을 선택하고 자동 시술 생성은 하지 않는다',async()=>{
    const {api,calls}=setup({records:[]});
    render(<TreatmentPage api={api} organizationId={org} readOnly={false} initialCustomerId={other}/>);
    await waitFor(()=>expect(calls.some(call=>call.path===`/organizations/${org}/customers/${other}/treatments`)).toBe(true));
    expect(calls.some(call=>call.path===`/organizations/${org}/customers/${cust}/treatments`)).toBe(false);
    expect(calls.every(call=>call.method==='GET')).toBe(true);
  });
  it('요청한 고객이 없을 때 목록 첫 고객으로 대체하지 않는다',async()=>{
    const {api,calls}=setup();
    render(<TreatmentPage api={api} organizationId={org} readOnly={false} initialCustomerId={doc}/>);
    expect(await screen.findByRole('alert')).toHaveTextContent('요청한 고객을 찾지 못했습니다');
    expect(calls.some(call=>call.path.endsWith('/treatments'))).toBe(false);
  });
  it('loads the first customer, shows cautions and history, and fills the editor from a selected record', async () => {
    const { view, calls } = setup();
    view();
    expect(await screen.findByText('수분 관리')).toBeInTheDocument();
    expect(screen.getByLabelText('고객 주의사항', { selector: 'div.treatment-cautions' })).toHaveTextContent('피부 타입 · 건성');
    expect(calls).toContainEqual(expect.objectContaining({ method: 'GET', path: `/organizations/${org}/customers/${cust}/treatments` }));
    await openRecord();
    expect(screen.getByLabelText('예정 금액')).toHaveValue('15000.50');
    expect(screen.getByText(/준비 · 버전 1/)).toBeInTheDocument();
    expect(screen.getByText('전체 1건 중 1건')).toBeInTheDocument();
  });

  it('opens preflight without modifying the record and protects an unsaved draft', async () => {
    const { view, calls } = setup({ handler: ({ method, path }) => method === 'GET' && path.endsWith('/documents') ? [] : undefined });
    view(); await openRecord();
    click('시술 전 확인');
    expect(await screen.findByRole('dialog', { name: '시술 전 확인' })).toBeInTheDocument();
    expect(await screen.findByText('이 시술에 발행한 문서가 없습니다.')).toBeInTheDocument();
    expect(pick(calls, '/mutations')).toHaveLength(0);
    fireEvent.click(screen.getByText('닫기', { selector: 'button' }));
    change('시술명 *', '변경 중인 시술명');
    expect(screen.getByRole('button', { name: '시술 전 확인' })).toBeDisabled();
    expect(screen.getByLabelText('시술명 *')).toHaveValue('변경 중인 시술명');
  });

  it('filters the history by text and category and reports an invalid date range', async () => {
    const { view } = setup({ records: [treatment(t1), treatment(t2, { treatment_name: '레이저', category: '장비', practitioner: '이담당', treatment_date: '2026-08-01' })] });
    view();
    await screen.findByText('레이저');
    fireEvent.change(screen.getByLabelText('시술 검색'), { target: { value: '이담당' } });
    expect(screen.getByText('전체 2건 중 1건')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('시술 검색'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('분류 필터'), { target: { value: '피부' } });
    expect(screen.getByText('전체 2건 중 1건')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('시작일'), { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByLabelText('종료일'), { target: { value: '2026-01-01' } });
    expect(screen.getByText('날짜 범위의 시작일이 종료일보다 늦습니다.')).toBeInTheDocument();
  });

  it('creates a record with validated JSON values and blocks invalid input without calling the API', async () => {
    const { view, calls } = setup({ records: [] });
    view();
    await screen.findByText('아직 시술 기록이 없습니다.');
    click('시술 기록 저장');
    expect(await screen.findByText('시술명을 입력하세요.')).toBeInTheDocument();
    change('시술명 *', '  신규 관리 ');
    change('예정 금액', '1.001');
    click('시술 기록 저장');
    expect(await screen.findByText(/금액은 0 이상/)).toBeInTheDocument();
    expect(pick(calls, '/treatments')).toHaveLength(0);
    change('예정 금액', '12000');
    change('다음 방문일', '2026-01-01');
    click('시술 기록 저장');
    expect(await screen.findByText('다음 방문일은 시술일 이후여야 합니다.')).toBeInTheDocument();
    change('다음 방문일', '');
    click('시술 기록 저장');
    await waitFor(() => expect(pick(calls, '/treatments')).toHaveLength(1));
    expect(pick(calls, '/treatments')[0].body).toMatchObject({ treatment_name: '신규 관리', amount: '12000', next_visit_date: null, notes: '' });
    expect(await screen.findByText('기록 수정')).toBeInTheDocument();
  });

  it('edits a draft through the mutation API with its version and one operation id', async () => {
    const { view, calls } = setup();
    view();
    await openRecord();
    change('시술명 *', '수정된 관리');
    click('시술 기록 저장');
    await waitFor(() => expect(pick(calls, '/mutations')).toHaveLength(1));
    const body = pick(calls, '/mutations')[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ action: 'edit', expected_version: 1, reason: '' });
    expect(body.operation_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.values).toMatchObject({ treatment_name: '수정된 관리', amount: '15000.50' });
    expect(await screen.findByText(/준비 · 버전 2/)).toBeInTheDocument();
  });

  it('retries a failed save with the same operation id', async () => {
    let attempts = 0;
    const { view, calls } = setup({
      handler: (entry) => { if (entry.path.endsWith('/mutations') && attempts++ === 0) throw new ApiError(503, 'HTTP_503', 'down', true); return undefined; },
    });
    view();
    await openRecord();
    change('시술명 *', '재시도 관리');
    click('시술 기록 저장');
    expect(await screen.findByText(/저장 실패 · 입력은 유지됩니다/)).toBeInTheDocument();
    expect(screen.getByLabelText('시술명 *')).toHaveValue('재시도 관리');
    click('시술 기록 저장');
    await waitFor(() => expect(pick(calls, '/mutations')).toHaveLength(2));
    const [first, second] = pick(calls, '/mutations').map((entry) => (entry.body as { operation_id: string }).operation_id);
    expect(second).toBe(first);
    expect(await screen.findByText(/준비 · 버전 2/)).toBeInTheDocument();
  });

  it('blocks saving after a version conflict until the history is refreshed', async () => {
    const { view, state } = setup();
    view();
    await openRecord();
    state.records = [{ ...state.records[0], version: 5 }];
    change('시술명 *', '충돌 입력');
    click('시술 기록 저장');
    expect(await screen.findByText(/다른 변경 또는 상태 충돌/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '시술 기록 저장' })).toBeDisabled();
    expect(screen.getByLabelText('시술명 *')).toHaveValue('충돌 입력');
    click('새로고침');
    fireEvent.click(await screen.findByRole('button', { name: '버리고 이동' }));
    await waitFor(() => expect(screen.getByText(/준비 · 버전 5/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: '시술 기록 저장' })).toBeEnabled();
  });

  it('asks before discarding edits when another record is selected', async () => {
    const { view } = setup({ records: [treatment(t1), treatment(t2, { treatment_name: '레이저', treatment_date: '2026-08-01' })] });
    view();
    await openRecord();
    change('시술명 *', '작성 중');
    fireEvent.click(screen.getByText('레이저'));
    fireEvent.click(await screen.findByRole('button', { name: '취소' }));
    expect(screen.getByLabelText('시술명 *')).toHaveValue('작성 중');
    fireEvent.click(screen.getByText('레이저'));
    fireEvent.click(await screen.findByRole('button', { name: '버리고 이동' }));
    await waitFor(() => expect(screen.getByLabelText('시술명 *')).toHaveValue('레이저'));
  });

  it('copies a record into an unsaved new record dated today without a next visit', async () => {
    const { view, calls } = setup({ records: [treatment(t1, { next_visit_date: '2026-10-01' })] });
    view();
    await openRecord();
    click('선택 기록 복사');
    expect(await screen.findByText('복사한 새 기록 · 저장 전')).toBeInTheDocument();
    expect(screen.getByLabelText('다음 방문일')).toHaveValue('');
    expect(screen.getByLabelText('시술명 *')).toHaveValue('수분 관리');
    expect(pick(calls, '/treatments')).toHaveLength(0);
  });

  it('requires a reviewed consultation before start, then walks start, complete and a reasoned cancel', async () => {
    const { view, calls } = setup();
    view();
    await openRecord();
    click('시작');
    expect(await screen.findByText(/상담 기록에서 목표를 입력하고/)).toBeInTheDocument();
    expect(pick(calls, '/mutations')).toHaveLength(0);

    click('상담 기록');
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/상담 목표/), { target: { value: '보습 관리' } });
    fireEvent.click(within(dialog).getByLabelText(/직접 확인했습니다/));
    fireEvent.click(within(dialog).getByRole('button', { name: '상담 초안 저장' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(pick(calls, '/mutations')[0].body).toMatchObject({ action: 'consult', expected_version: 1, values: { goal: '보습 관리', plan: '', acknowledge_cautions: true, expected_cautions: cautions } });

    click('시작');
    expect(await screen.findByText(/진행 중 · 버전 3/)).toBeInTheDocument();
    click('완료');
    expect(await screen.findByText(/완료 · 버전 4/)).toBeInTheDocument();
    expect(pick(calls, '/mutations').map((entry) => (entry.body as { action: string }).action)).toEqual(['consult', 'start', 'complete']);
  });

  it('cancels with a mandatory reason', async () => {
    const { view, calls } = setup({ records: [readyRecord()] });
    view();
    await openRecord();
    click('중단');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: '중단 확정' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/중단 사유/), { target: { value: '  고객 요청  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '중단 확정' }));
    expect(await screen.findByText(/중단 · 버전 2/)).toBeInTheDocument();
    expect(pick(calls, '/mutations')[0].body).toMatchObject({ action: 'cancel', reason: '고객 요청', values: null });
  });

  it('keeps stale consultations out: a changed customer caution forces a new acknowledgement before start', async () => {
    const stale = treatment(t1, { ...readyRecord(), cautions_snapshot: { ...cautions, allergies: '다른 값' } });
    const { view } = setup({ records: [stale] });
    view();
    await openRecord();
    click('시작');
    expect(await screen.findByText(/상담 기록에서 목표를 입력하고/)).toBeInTheDocument();
    click('상담 기록');
    expect(await screen.findByText(/고객 정보 변경 · 다시 확인 필요/)).toBeInTheDocument();
  });

  it('corrects a completed record only with a reason', async () => {
    const { view, calls } = setup({ records: [treatment(t1, { status: 'completed', version: 3, ended_at: '2026-09-21T02:00:00Z' })] });
    view();
    await openRecord();
    expect(screen.getByLabelText('시술명 *')).toHaveAttribute('readonly');
    expect(screen.getByRole('button', { name: '시술 기록 저장' })).toBeDisabled();
    click('정정');
    change('시술명 *', '정정된 관리');
    click('정정 내용 저장');
    expect(await screen.findByText('정정 사유를 입력하세요.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/정정 사유/), { target: { value: '오기 정정' } });
    click('정정 내용 저장');
    await waitFor(() => expect(pick(calls, '/mutations')).toHaveLength(1));
    expect(pick(calls, '/mutations')[0].body).toMatchObject({ action: 'correct', reason: '오기 정정', expected_version: 3, values: { treatment_name: '정정된 관리' } });
  });

  it('shows the change history and offers a retry when loading fails', async () => {
    let failures = 1;
    const { view } = setup({
      handler: (entry) => {
        if (entry.path.endsWith('/events')) {
          if (failures-- > 0) throw new ApiError(503, 'HTTP_503', 'down', true);
          return [{ id: t2, actor_id: actor, action: 'correct', reason: '오기 정정', occurred_at: '2026-09-22T01:00:00Z', before_data: { notes: '이전' }, after_data: { notes: '이후' } }];
        }
        return undefined;
      },
    });
    view();
    await openRecord();
    click('변경 이력');
    expect(await screen.findByText('변경 이력을 불러오지 못했습니다.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText(/기록 정정/)).toBeInTheDocument();
    expect(screen.getByText('사유: 오기 정정')).toBeInTheDocument();
    expect(screen.getByText('시술 내용: 이전 → 이후')).toBeInTheDocument();
  });

  describe('sale draft handoff', () => {
    const completed = () => treatment(t1, { status: 'completed', version: 3, amount: '30000.00' });
    const preview = { values: { description: '수분 관리', amount: '30000.00', consent_document_id: null, exception_reason: '별도 확인', partial_reason: '' }, line: { description: '수분 관리', quantity: 1, unit_price: '30000.00', line_total: '30000.00', practitioner: '김담당' }, total_amount: '30000.00', source_snapshot: { customer: { name: '김고객' } }, consent_status: 'not_linked', warnings: ['동의 예외 확인'] };
    const draft = { id: doc, organization_id: org, customer_id: cust, treatment_id: t1, status: 'draft', description: '수분 관리', amount: '30000.00', source_snapshot: { customer: { name: '김고객' }, treatment: { practitioner: '김담당', version: 3 }, consent: { status: 'not_linked' }, exception_reason: '별도 확인', partial_reason: '' }, created_by: actor, created_at: '2026-09-22T01:00:00Z' };

    it('previews, requires confirmation and retries a lost response with the same operation id', async () => {
      let sends = 0;
      const { view, calls } = setup({
        records: [completed()],
        handler: (entry) => {
          if (entry.path.endsWith('/sale-draft/preview')) return preview;
          if (entry.method === 'POST' && entry.path.endsWith('/sale-draft')) { if (sends++ === 0) throw new ApiError(503, 'HTTP_503', 'down', true); return draft; }
          return undefined;
        },
      });
      view();
      await openRecord();
      click('결제 초안');
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getByLabelText('청구 항목')).toBeEnabled());
      expect(within(dialog).getByLabelText('청구 항목')).toHaveValue('수분 관리');
      expect(within(dialog).getByLabelText('검토 금액')).toHaveValue('30000.00');
      expect(within(dialog).getByRole('button', { name: '결제 초안으로 전달' })).toBeDisabled();
      fireEvent.change(within(dialog).getByLabelText('동의 예외 사유'), { target: { value: '별도 확인' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '최신 시술·동의 상태로 검토' }));
      expect(await within(dialog).findByText('동의 예외 확인')).toBeInTheDocument();
      expect(pick(calls, '/sale-draft/preview')[0].body).toEqual({ values: preview.values });
      fireEvent.click(within(dialog).getByLabelText(/실제 수행 항목/));
      fireEvent.click(within(dialog).getByRole('button', { name: '결제 초안으로 전달' }));
      expect(await within(dialog).findByText(/요청을 완료하지 못했습니다/)).toBeInTheDocument();
      fireEvent.click(within(dialog).getByRole('button', { name: '같은 요청 재시도' }));
      expect(await within(dialog).findByText(/결제 초안 · 미수납/)).toBeInTheDocument();
      const sent = calls.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/sale-draft'));
      expect(sent).toHaveLength(2);
      expect(sent[1].body).toEqual(sent[0].body);
      expect(sent[0].body).toMatchObject({ confirmed: true, expected_preview: preview });
    });

    it('requires a partial-work reason for cancelled treatments and rejects bad amounts locally', async () => {
      const { view, calls } = setup({ records: [{ ...completed(), status: 'cancelled' }] });
      view();
      await openRecord();
      click('결제 초안');
      const dialog = await screen.findByRole('dialog');
      await waitFor(() => expect(within(dialog).getByLabelText('청구 항목')).toBeEnabled());
      fireEvent.change(within(dialog).getByLabelText('청구 항목'), { target: { value: '부분 시술' } });
      fireEvent.change(within(dialog).getByLabelText('검토 금액'), { target: { value: '1000' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '최신 시술·동의 상태로 검토' }));
      expect(await within(dialog).findByText(/중단 시 부분 수행 사유가 필요합니다/)).toBeInTheDocument();
      fireEvent.change(within(dialog).getByLabelText('부분 수행·청구 사유'), { target: { value: '절반 수행' } });
      fireEvent.change(within(dialog).getByLabelText('검토 금액'), { target: { value: '1e3' } });
      fireEvent.click(within(dialog).getByRole('button', { name: '최신 시술·동의 상태로 검토' }));
      expect(await within(dialog).findByText(/청구 항목과 금액을 확인하세요/)).toBeInTheDocument();
      expect(pick(calls, '/sale-draft/preview')).toHaveLength(0);
    });

    it('shows an existing draft read-only and clears a rejected request on conflict', async () => {
      const { view } = setup({ records: [completed()], handler: (entry) => (entry.method === 'GET' && entry.path.endsWith('/sale-draft') ? [draft] : undefined) });
      view();
      await openRecord();
      click('결제 초안');
      const dialog = await screen.findByRole('dialog');
      expect(await within(dialog).findByText(/결제 초안 · 미수납/)).toBeInTheDocument();
      expect(within(dialog).queryByRole('button', { name: '결제 초안으로 전달' })).not.toBeInTheDocument();
    });

    it('lists the pending drafts of the organization in the inbox dialog', async () => {
      const { api } = setup({ handler: (entry) => (entry.path.endsWith('/treatment-sale-drafts') ? [draft] : undefined) });
      render(<SaleDraftInboxDialog api={api} organizationId={org} onClose={() => undefined} />);
      fireEvent.click(await screen.findByRole('button', { name: /김고객 · 수분 관리 · 30000.00/ }));
      expect(await screen.findByText('결제 초안 · 미수납')).toBeInTheDocument();
      expect(screen.getByText('미수납 결제 초안 1건')).toBeInTheDocument();
    });
  });

  it('hides every write control for read-only members but keeps history and cautions viewable', async () => {
    const { view } = setup({ records: [readyRecord()] });
    view(true);
    await openRecord();
    for (const name of ['시술 기록 저장', '새 기록', '선택 기록 복사', '시작', '완료', '중단', '정정']) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.getByLabelText('시술명 *')).toHaveAttribute('readonly');
    expect(screen.getByText('기록 조회 · 읽기 전용')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '변경 이력' })).toBeEnabled();
    click('상담 기록');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: '상담 초안 저장' })).not.toBeInTheDocument();
    expect(within(dialog).getByText('준비 상태에서만 상담을 수정할 수 있습니다.')).toBeInTheDocument();
  });

  it('offers a retry when the customer list or the history cannot be loaded', async () => {
    let customerFailures = 1;
    const { view } = setup({ listCustomers: async () => { if (customerFailures-- > 0) throw new ApiError(503, 'HTTP_503', 'down', true); return [customer(cust, '김고객')]; } });
    view();
    expect(await screen.findByText('고객 목록을 불러오지 못했습니다.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('수분 관리')).toBeInTheDocument();

    let historyFailures = 1;
    const second = setup({ handler: (entry) => { if (entry.method === 'GET' && entry.path.endsWith('/treatments') && historyFailures-- > 0) throw new ApiError(503, 'HTTP_503', 'down', true); return undefined; } });
    second.view();
    expect(await screen.findByText('시술 이력을 불러오지 못했습니다.')).toBeInTheDocument();
    const retry = screen.getAllByRole('button', { name: '다시 시도' }).at(-1)!;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getAllByText('수분 관리').length).toBeGreaterThan(0));
  });

  it('switches customers, ignoring the previous customer history, and shows an empty notice without customers', async () => {
    const { view, calls } = setup();
    view();
    await screen.findByText('수분 관리');
    fireEvent.click(screen.getByRole('button', { name: /박고객/ }));
    await waitFor(() => expect(calls.some((entry) => entry.path.includes(`/customers/${other}/treatments`))).toBe(true));
    expect(screen.getByLabelText('고객 주의사항', { selector: 'div.treatment-cautions' })).toHaveTextContent('미등록 · 상담 시 확인');

    const empty = setup({ customers: [] });
    empty.view();
    expect((await screen.findAllByText('고객관리에서 고객을 먼저 등록하세요.')).length).toBeGreaterThan(0);
  });
  describe('customer photos', () => {
    const photo = (id: string, name: string, createdAt: string) => ({ id, organization_id: org, customer_id: cust, original_name: name, storage_path: 'p', content_type: 'image/jpeg', size_bytes: 2048, caption: '', created_at: createdAt });
    const photos = [
      photo('a1111111-1111-4111-8111-111111111111', 'other.jpg', '2026-09-01T03:00:00Z'),
      photo('b2222222-2222-4222-8222-222222222222', 'day.jpg', '2026-09-17T15:30:00Z'),
    ];
    beforeEach(() => {
      URL.createObjectURL = vi.fn(() => 'blob:test');
      URL.revokeObjectURL = vi.fn();
    });

    it('shows the selected customer photos large and highlights the same-day photos for the selected treatment', async () => {
      const { view } = setup({ photos });
      view();
      await screen.findByText('수분 관리');
      expect(await screen.findByLabelText('day.jpg 크게 보기')).toBeInTheDocument();
      expect(screen.getByLabelText('other.jpg 크게 보기')).toBeInTheDocument();
      expect(document.querySelector('.pg-root')).toHaveAttribute('data-size', 'large');
      await openRecord();
      const highlighted = await screen.findByRole('region', { name: '시술일 사진 · 2026-09-18 · 1장' });
      expect(within(highlighted).getByLabelText('day.jpg 크게 보기')).toBeInTheDocument();
      expect(within(highlighted).queryByLabelText('other.jpg 크게 보기')).not.toBeInTheDocument();
      expect(screen.getByRole('region', { name: '2026-09-01 · 1장' })).toBeInTheDocument();
    });

    it('hides upload and archive actions for read-only members', async () => {
      const { view } = setup({ photos });
      view(true);
      await screen.findByLabelText('day.jpg 크게 보기');
      expect(screen.queryByRole('button', { name: '사진 추가' })).not.toBeInTheDocument();
      fireEvent.click(screen.getByLabelText('day.jpg 크게 보기'));
      expect(await screen.findByRole('dialog')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: '삭제' })).not.toBeInTheDocument();
    });

    it('can be collapsed without losing the loaded photos', async () => {
      const { view } = setup({ photos });
      view();
      await screen.findByLabelText('day.jpg 크게 보기');
      fireEvent.click(screen.getByRole('button', { name: '접기' }));
      expect(screen.getByRole('button', { name: '펼치기' })).toHaveAttribute('aria-expanded', 'false');
      fireEvent.click(screen.getByRole('button', { name: '펼치기' }));
      expect(screen.getByLabelText('day.jpg 크게 보기')).toBeVisible();
    });
  });
});

describe('TreatmentPage 프로토콜 템플릿(TRT-12)', () => {
  const tplA = '99999999-9999-4999-8999-999999999991';
  const tpl = { id: tplA, organization_id: org, name: '기본 페이셜', category: '피부', treatment_name: '수분 페이셜', notes: '1. 클렌징\n2. 팩', consultation_goal: '수분 개선', consultation_plan: '4주 간격', version: 1, updated_at: '2026-10-14T00:00:00Z' };
  const withTemplates = (): Handler => (entry) => (entry.method === 'GET' && entry.path.endsWith('/treatment-templates') ? [tpl] : undefined);

  it('새 기록 폼에서 템플릿을 고르면 시술명·분류·내용이 복사되고 다른 칸은 그대로다', async () => {
    const { view } = setup({ records: [], handler: withTemplates() });
    view();
    await screen.findByText('아직 시술 기록이 없습니다.');
    change('담당자', '김담당');
    fireEvent.change(await screen.findByLabelText('시술 템플릿'), { target: { value: tplA } });
    await waitFor(() => expect(screen.getByLabelText('시술명 *')).toHaveValue('수분 페이셜'));
    expect(screen.getByLabelText('분류')).toHaveValue('피부');
    expect(screen.getByLabelText(/시술 내용/)).toHaveValue('1. 클렌징\n2. 팩');
    expect(screen.getByLabelText('담당자')).toHaveValue('김담당');
  });

  it('이미 쓴 내용이 달라지면 확인을 받고 취소하면 그대로 둔다', async () => {
    const { view } = setup({ records: [], handler: withTemplates() });
    view();
    await screen.findByText('아직 시술 기록이 없습니다.');
    change('시술명 *', '직접 쓴 시술');
    fireEvent.change(await screen.findByLabelText('시술 템플릿'), { target: { value: tplA } });
    fireEvent.click(within(await screen.findByRole('dialog', { name: '템플릿 불러오기' })).getByRole('button', { name: '취소' }));
    expect(screen.getByLabelText('시술명 *')).toHaveValue('직접 쓴 시술');
    fireEvent.change(screen.getByLabelText('시술 템플릿'), { target: { value: tplA } });
    fireEvent.click(within(await screen.findByRole('dialog', { name: '템플릿 불러오기' })).getByRole('button', { name: '바꾸기' }));
    await waitFor(() => expect(screen.getByLabelText('시술명 *')).toHaveValue('수분 페이셜'));
  });

  it('불러온 값은 저장 전까지 시술 기록에 반영되지 않고 저장 본문에는 템플릿 정보가 없다', async () => {
    const { view, calls } = setup({ records: [], handler: withTemplates() });
    view();
    await screen.findByText('아직 시술 기록이 없습니다.');
    fireEvent.change(await screen.findByLabelText('시술 템플릿'), { target: { value: tplA } });
    await waitFor(() => expect(screen.getByLabelText('시술명 *')).toHaveValue('수분 페이셜'));
    expect(pick(calls, '/treatments')).toHaveLength(0);
    click('시술 기록 저장');
    await waitFor(() => expect(pick(calls, '/treatments')).toHaveLength(1));
    const body = pick(calls, '/treatments')[0].body as Record<string, unknown>;
    expect(body).toMatchObject({ treatment_name: '수분 페이셜', category: '피부', notes: '1. 클렌징\n2. 팩' });
    expect(Object.keys(body).some((key) => key.includes('template'))).toBe(false);
  });

  it('템플릿이 없으면 선택 칸을 보이지 않고, 조회 전용이면 선택도 관리도 없다', async () => {
    const empty = setup({ records: [] });
    empty.view();
    await screen.findByText('아직 시술 기록이 없습니다.');
    expect(screen.queryByLabelText('시술 템플릿')).not.toBeInTheDocument();
  });

  it('조회 전용 구성원에게는 템플릿 선택과 관리 버튼이 없다', async () => {
    const { view } = setup({ handler: withTemplates() });
    view(true);
    await screen.findByText('수분 관리');
    expect(screen.queryByLabelText('시술 템플릿')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '템플릿 관리' })).not.toBeInTheDocument();
  });

  it('템플릿 관리 버튼으로 관리 창을 열고 닫으면 목록을 다시 읽는다', async () => {
    const { view, calls } = setup({ handler: withTemplates() });
    view();
    await screen.findByText('수분 관리');
    const before = calls.filter((entry) => entry.method === 'GET' && entry.path.endsWith('/treatment-templates')).length;
    click('템플릿 관리');
    expect(await screen.findByRole('dialog', { name: '시술 프로토콜 템플릿' })).toBeInTheDocument();
    expect(calls.filter((entry) => entry.method === 'GET' && entry.path.endsWith('/treatment-templates')).length).toBeGreaterThan(before);
  });

  it('상담 창에서 템플릿으로 상담 목표·예정 관리를 채운다', async () => {
    const { view } = setup({ handler: withTemplates() });
    view();
    await openRecord();
    click('상담 기록');
    const dialog = await screen.findByRole('dialog', { name: /상담 기록/ });
    fireEvent.change(await within(dialog).findByLabelText('상담 템플릿'), { target: { value: tplA } });
    await waitFor(() => expect(within(dialog).getByLabelText(/상담 목표/)).toHaveValue('수분 개선'));
    expect(within(dialog).getByLabelText(/예정 관리 내용/)).toHaveValue('4주 간격');
  });
});
