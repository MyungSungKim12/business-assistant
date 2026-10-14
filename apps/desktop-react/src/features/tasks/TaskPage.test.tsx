import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '@business-assistant/react-ui';
import type { Task } from '../../api/schemas';
import { TaskPage } from './TaskPage';

const ORG = '22222222-2222-4222-8222-222222222222';
const TODAY = '2026-10-15';
const CUSTOMER = '44444444-4444-4444-8444-444444444444';
const local = (y: number, m: number, d: number, h = 10, mi = 0) => new Date(y, m - 1, d, h, mi).toISOString();

function makeTask(n: number, patch: Partial<Task> = {}): Task {
  return { id: `00000000-0000-4000-8000-00000000000${n}`, organization_id: ORG, created_by: '33333333-3333-4333-8333-333333333333', title: `할일${n}`, description: `설명${n}`, due_at: null, status: 'open', priority: 'normal', labels: [], checklist: [], ...patch };
}
const seed = () => [
  makeTask(1, { title: '재고 확인', due_at: local(2026, 10, 15, 10), priority: 'high' }),
  makeTask(2, { title: '고객 연락', due_at: local(2026, 10, 20, 14), status: 'done' }),
  makeTask(3, { title: '청소', due_at: null, priority: 'low' }),
];

function makeApi(initial: Task[] = seed()) {
  let rows = [...initial];
  return {
    listTasks: vi.fn(async () => rows),
    listCustomers: vi.fn(async () => [{ id: CUSTOMER, organization_id: ORG, name: '박고객', status: 'active' }]),
    createTask: vi.fn(async (_o: string, input: Pick<Task, 'title' | 'description' | 'due_at'> & { priority: string }) => {
      const created = makeTask(rows.length + 5, { ...input });
      rows = [...rows, created];
      return created;
    }),
    updateTask: vi.fn(async (_o: string, id: string, patch: Partial<Task>) => {
      const next = { ...rows.find((row) => row.id === id)!, ...patch };
      rows = rows.map((row) => (row.id === id ? next : row));
      return next;
    }),
    deleteTask: vi.fn(async (_o: string, id: string) => { rows = rows.filter((row) => row.id !== id); }),
  };
}
type TestApi = ReturnType<typeof makeApi>;

function renderPage(api: TestApi, props: { readOnly?: boolean } = {}) {
  return render(<><TaskPage api={api as never} organizationId={ORG} todayKey={TODAY} {...props} /><ConfirmDialog /></>);
}
const grid = () => screen.getAllByRole('grid', { name: '할 일 목록' })[0];
const calendar = () => screen.getByRole('grid', { name: '할 일 달력 격자' });
const cell = (key: string) => calendar().querySelector(`[data-date="${key}"]`) as HTMLElement;
const detail = () => screen.getByRole('complementary', { name: '할 일 상세' });
async function ready() { await screen.findByText('재고 확인', { selector: 'td' }); }
const dragData = () => ({ setData: vi.fn(), getData: vi.fn(), effectAllowed: '' });

describe('TaskPage 목록과 필터', () => {
  it('목록 행 선택 시 우측 상세에 내용이 표시된다', async () => {
    renderPage(makeApi());
    await ready();
    fireEvent.click(within(grid()).getByText('고객 연락'));
    expect(within(detail()).getByLabelText('제목')).toHaveValue('고객 연락');
    expect(within(detail()).getByLabelText('설명')).toHaveValue('설명2');
    expect(within(detail()).getByLabelText('기한')).toHaveValue('2026-10-20T14:00');
    expect(within(detail()).getByRole('button', { name: '다시 열기' })).toBeInTheDocument();
  });

  it('제목 검색, 상태, 우선순위로 거른다', async () => {
    renderPage(makeApi());
    await ready();
    fireEvent.change(screen.getByLabelText('할 일 검색'), { target: { value: '청소' } });
    expect(within(grid()).queryByText('재고 확인')).not.toBeInTheDocument();
    expect(within(grid()).getByText('청소')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('할 일 검색'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('상태 필터'), { target: { value: 'done' } });
    expect(within(grid()).getAllByRole('row')).toHaveLength(2); // 머리글 + 1건
    fireEvent.change(screen.getByLabelText('상태 필터'), { target: { value: 'all' } });
    fireEvent.change(screen.getByLabelText('우선순위 필터'), { target: { value: 'high' } });
    expect(within(grid()).getByText('재고 확인')).toBeInTheDocument();
    expect(within(grid()).queryByText('고객 연락')).not.toBeInTheDocument();
  });

  it('기한 날짜·기간·빠른 버튼으로 거른다', async () => {
    renderPage(makeApi());
    await ready();
    fireEvent.change(screen.getByLabelText('시작일'), { target: { value: '2026-10-20' } });
    fireEvent.change(screen.getByLabelText('종료일'), { target: { value: '2026-10-20' } });
    expect(within(grid()).getByText('고객 연락')).toBeInTheDocument();
    expect(within(grid()).queryByText('재고 확인')).not.toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('group', { name: '기한 빠른 선택' })).getByRole('button', { name: '오늘' }));
    expect(screen.getByLabelText('시작일')).toHaveValue(TODAY);
    expect(within(grid()).getByText('재고 확인')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '이번 달' }));
    expect(within(grid()).getByText('고객 연락')).toBeInTheDocument();
    expect(within(grid()).queryByText('청소')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '전체' }));
    expect(within(grid()).getByText('청소')).toBeInTheDocument();
  });
});

describe('TaskPage 상세 편집', () => {
  it('선택이 없으면 신규 등록 양식이 보이고 등록 후 상세로 전환된다', async () => {
    const api = makeApi();
    renderPage(api);
    await ready();
    expect(within(detail()).getByRole('heading', { name: '새 할 일 등록' })).toBeInTheDocument();
    fireEvent.change(within(detail()).getByLabelText('제목'), { target: { value: '새 업무' } });
    fireEvent.click(within(detail()).getByRole('button', { name: '할 일 등록' }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledWith(ORG, expect.objectContaining({ title: '새 업무', due_at: null, priority: 'normal' })));
    expect(await within(grid()).findByText('새 업무')).toBeInTheDocument();
    expect(within(detail()).getByRole('heading', { name: '할 일 상세' })).toBeInTheDocument();
  });

  it('등록 실패 시 입력을 유지하고 오류를 보여 준 뒤 재시도할 수 있다', async () => {
    const api = makeApi();
    api.createTask.mockRejectedValueOnce(new Error('network'));
    renderPage(api);
    await ready();
    fireEvent.change(within(detail()).getByLabelText('제목'), { target: { value: '재시도' } });
    fireEvent.click(within(detail()).getByRole('button', { name: '할 일 등록' }));
    expect(await within(detail()).findByRole('alert')).toHaveTextContent('등록하지 못했습니다');
    expect(within(detail()).getByLabelText('제목')).toHaveValue('재시도');
    fireEvent.click(within(detail()).getByRole('button', { name: '할 일 등록' }));
    await waitFor(() => expect(api.createTask).toHaveBeenCalledTimes(2));
    expect(await within(grid()).findByText('재시도')).toBeInTheDocument();
  });

  it('상세에서 수정 저장하면 목록에 반영된다', async () => {
    const api = makeApi();
    renderPage(api);
    await ready();
    fireEvent.click(within(grid()).getByText('재고 확인'));
    expect(within(detail()).getByRole('button', { name: '저장' })).toBeDisabled();
    fireEvent.change(within(detail()).getByLabelText('제목'), { target: { value: '재고 실사' } });
    fireEvent.change(within(detail()).getByLabelText('기한'), { target: { value: '2026-10-16T11:00' } });
    fireEvent.click(within(detail()).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ORG, seed()[0].id, expect.objectContaining({ title: '재고 실사', due_at: local(2026, 10, 16, 11), priority: 'high' })));
    expect(await within(grid()).findByText('재고 실사')).toBeInTheDocument();
  });

  it('저장 실패 시 입력이 유지된다', async () => {
    const api = makeApi();
    api.updateTask.mockRejectedValueOnce(new Error('x'));
    renderPage(api);
    await ready();
    fireEvent.click(within(grid()).getByText('청소'));
    fireEvent.change(within(detail()).getByLabelText('제목'), { target: { value: '대청소' } });
    fireEvent.click(within(detail()).getByRole('button', { name: '저장' }));
    expect(await within(detail()).findByRole('alert')).toHaveTextContent('저장하지 못했습니다');
    expect(within(detail()).getByLabelText('제목')).toHaveValue('대청소');
  });

  it('상태 변경 버튼이 상태를 바꾼다', async () => {
    const api = makeApi();
    renderPage(api);
    await ready();
    fireEvent.click(within(grid()).getByText('재고 확인'));
    fireEvent.click(within(detail()).getByRole('button', { name: '시작' }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ORG, seed()[0].id, { status: 'in_progress' }));
    expect(await within(detail()).findByRole('button', { name: '완료' })).toBeInTheDocument();
    expect(within(detail()).queryByRole('button', { name: '시작' })).not.toBeInTheDocument();
  });

  it('삭제는 확인 대화상자를 거치고 취소하면 삭제하지 않는다', async () => {
    const api = makeApi();
    renderPage(api);
    await ready();
    fireEvent.click(within(grid()).getByText('청소'));
    fireEvent.click(within(detail()).getByRole('button', { name: '삭제' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.deleteTask).not.toHaveBeenCalled();
    fireEvent.click(within(detail()).getByRole('button', { name: '삭제' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '삭제' }));
    await waitFor(() => expect(api.deleteTask).toHaveBeenCalledWith(ORG, seed()[2].id));
    await waitFor(() => expect(within(grid()).queryByText('청소')).not.toBeInTheDocument());
    expect(within(detail()).getByRole('heading', { name: '새 할 일 등록' })).toBeInTheDocument();
  });

  it('작성 중 다른 행을 선택하면 확인을 받고, 취소하면 현재 입력을 유지한다', async () => {
    renderPage(makeApi());
    await ready();
    fireEvent.change(within(detail()).getByLabelText('제목'), { target: { value: '작성 중' } });
    fireEvent.click(within(grid()).getByText('청소'));
    let dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(within(detail()).getByLabelText('제목')).toHaveValue('작성 중');
    fireEvent.click(within(grid()).getByText('청소'));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '버리기' }));
    await waitFor(() => expect(within(detail()).getByLabelText('제목')).toHaveValue('청소'));
  });
});

describe('TaskPage 달력', () => {
  it('오늘 강조, 요일 머리글, 6주 격자, 칩 표시와 완료 취소선 클래스', async () => {
    renderPage(makeApi());
    await ready();
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent).filter((t) => '일월화수목금토'.includes(t ?? 'x') && t)).toEqual(['일', '월', '화', '수', '목', '금', '토']);
    expect(calendar().querySelectorAll('.tasks-cal__week')).toHaveLength(6);
    expect(cell(TODAY)).toHaveClass('is-today');
    expect(within(cell(TODAY)).getByRole('button', { name: /재고 확인/ })).toHaveClass('tasks-chip--high');
    expect(within(cell('2026-10-20')).getByRole('button', { name: /고객 연락/ })).toHaveClass('tasks-chip--done');
    expect(screen.getByText('2026년 10월')).toBeInTheDocument();
  });

  it('이전/다음/오늘과 주 보기 전환', async () => {
    renderPage(makeApi());
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '다음' }));
    expect(screen.getByText('2026년 11월')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '이전' }));
    fireEvent.click(screen.getByRole('button', { name: '이전' }));
    expect(screen.getByText('2026년 9월')).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole('region', { name: '할 일 달력' })).getByRole('button', { name: '오늘' }));
    expect(screen.getByText('2026년 10월')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '주' }));
    expect(calendar().querySelectorAll('[role="gridcell"]')).toHaveLength(7);
  });

  it('한 날짜에 칩이 많으면 +N개로 줄여 보여 준다', async () => {
    const many = [1, 2, 3, 4, 5].map((n) => makeTask(n, { title: `업무${n}`, due_at: local(2026, 10, 15, 8 + n) }));
    renderPage(makeApi(many));
    await screen.findByText('업무1', { selector: 'td' });
    expect(within(cell(TODAY)).getAllByRole('button').filter((b) => b.classList.contains('tasks-chip'))).toHaveLength(2);
    expect(within(cell(TODAY)).getByText('+3개')).toBeInTheDocument();
  });

  it('칩을 클릭하면 상세 패널에서 열린다', async () => {
    renderPage(makeApi());
    await ready();
    fireEvent.click(within(cell('2026-10-20')).getByRole('button', { name: /고객 연락/ }));
    expect(within(detail()).getByLabelText('제목')).toHaveValue('고객 연락');
  });

  it('날짜 셀 클릭은 목록을 그 날짜로 거르고 등록 양식 기한을 채운다', async () => {
    renderPage(makeApi());
    await ready();
    fireEvent.click(cell('2026-10-20'));
    expect(screen.getByLabelText('시작일')).toHaveValue('2026-10-20');
    expect(within(grid()).queryByText('재고 확인')).not.toBeInTheDocument();
    expect(within(grid()).getByText('고객 연락')).toBeInTheDocument();
    expect(within(detail()).getByLabelText('기한')).toHaveValue('2026-10-20T09:00');
    expect(cell('2026-10-20')).toHaveClass('is-selected');
  });

  it('기한 없음 영역에 칩이 표시된다', async () => {
    renderPage(makeApi());
    await ready();
    const undated = screen.getByRole('complementary', { name: '기한 없음' });
    expect(within(undated).getByRole('button', { name: /청소/ })).toBeInTheDocument();
  });

  it('드래그로 다른 날짜로 옮기면 기한이 바뀐다(시각 유지)', async () => {
    const api = makeApi();
    renderPage(api);
    await ready();
    const chip = within(cell(TODAY)).getByRole('button', { name: /재고 확인/ });
    fireEvent.dragStart(chip, { dataTransfer: dragData() });
    fireEvent.dragOver(cell('2026-10-22'), { dataTransfer: dragData() });
    fireEvent.drop(cell('2026-10-22'), { dataTransfer: dragData() });
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ORG, seed()[0].id, { due_at: local(2026, 10, 22, 10) }));
    expect(await within(cell('2026-10-22')).findByRole('button', { name: /재고 확인/ })).toBeInTheDocument();
    expect(within(cell(TODAY)).queryByRole('button', { name: /재고 확인/ })).not.toBeInTheDocument();
  });

  it('드래그 이동이 실패하면 원위치로 돌리고 오류를 알린다', async () => {
    const api = makeApi();
    api.updateTask.mockRejectedValueOnce(new Error('fail'));
    renderPage(api);
    await ready();
    const chip = within(cell(TODAY)).getByRole('button', { name: /재고 확인/ });
    fireEvent.dragStart(chip, { dataTransfer: dragData() });
    fireEvent.drop(cell('2026-10-22'), { dataTransfer: dragData() });
    expect(await screen.findByRole('alert')).toHaveTextContent('원래 날짜로 되돌렸습니다');
    expect(within(cell(TODAY)).getByRole('button', { name: /재고 확인/ })).toBeInTheDocument();
    expect(within(cell('2026-10-22')).queryByRole('button', { name: /재고 확인/ })).not.toBeInTheDocument();
  });

  it('기한 없음 영역으로 드롭하면 기한이 해제된다', async () => {
    const api = makeApi();
    renderPage(api);
    await ready();
    fireEvent.dragStart(within(cell(TODAY)).getByRole('button', { name: /재고 확인/ }), { dataTransfer: dragData() });
    fireEvent.drop(screen.getByRole('complementary', { name: '기한 없음' }), { dataTransfer: dragData() });
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ORG, seed()[0].id, { due_at: null }));
  });
});

describe('TaskPage 조회 전용과 상태 화면', () => {
  it('readOnly면 등록·편집·삭제·드래그가 없다', async () => {
    const api = makeApi();
    renderPage(api, { readOnly: true });
    await ready();
    expect(screen.queryByRole('button', { name: '새 할 일' })).not.toBeInTheDocument();
    expect(within(detail()).queryByLabelText('제목')).not.toBeInTheDocument();
    fireEvent.click(within(grid()).getByText('재고 확인'));
    expect(within(detail()).getByLabelText('제목')).toBeDisabled();
    expect(within(detail()).queryByRole('button', { name: '저장' })).not.toBeInTheDocument();
    expect(within(detail()).queryByRole('button', { name: '삭제' })).not.toBeInTheDocument();
    expect(within(cell(TODAY)).getByRole('button', { name: /재고 확인/ })).toHaveAttribute('draggable', 'false');
    fireEvent.dragStart(within(cell(TODAY)).getByRole('button', { name: /재고 확인/ }), { dataTransfer: dragData() });
    fireEvent.drop(cell('2026-10-22'), { dataTransfer: dragData() });
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it('0건이어도 표 머리글·상세·달력이 모두 있다', async () => {
    renderPage(makeApi([]));
    expect(await screen.findByText('등록된 할 일이 없습니다.')).toBeInTheDocument();
    expect(within(grid()).getAllByRole('columnheader').length).toBeGreaterThanOrEqual(4);
    expect(detail()).toBeInTheDocument();
    expect(calendar().querySelectorAll('[role="gridcell"]')).toHaveLength(42);
    expect(screen.getByRole('complementary', { name: '기한 없음' })).toBeInTheDocument();
  });

  it('불러오는 중에도 레이아웃 요소가 있다', () => {
    const api = makeApi();
    api.listTasks.mockImplementation(() => new Promise(() => undefined));
    renderPage(api);
    expect(screen.getByText('불러오는 중…')).toBeInTheDocument();
    expect(within(grid()).getAllByRole('columnheader').length).toBeGreaterThanOrEqual(4);
    expect(detail()).toBeInTheDocument();
    expect(calendar()).toBeInTheDocument();
  });

  it('불러오기 오류가 나도 레이아웃을 유지하고 다시 시도할 수 있다', async () => {
    const api = makeApi();
    api.listTasks.mockRejectedValueOnce(new Error('x'));
    renderPage(api);
    expect(await screen.findByRole('alert')).toHaveTextContent('불러오지 못했습니다');
    expect(detail()).toBeInTheDocument();
    expect(calendar()).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(await within(grid()).findByText('재고 확인')).toBeInTheDocument();
  });
});

describe('TaskPage 일괄 완료(TASK-02)', () => {
  it('보이는 미완료 할 일만 확인 후 완료 처리한다', async () => {
    const api = makeApi();
    renderPage(api);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '보이는 2건 완료' }));
    fireEvent.click(await screen.findByRole('button', { name: '모두 완료' }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledTimes(2));
    expect(api.updateTask).toHaveBeenCalledWith(ORG, expect.any(String), { status: 'done' });
    expect(api.updateTask.mock.calls.map((call) => call[1]).sort()).toEqual(['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000003']);
    await waitFor(() => expect(screen.queryByRole('button', { name: /건 완료$/ })).not.toBeInTheDocument());
  });

  it('필터를 걸면 보이는 항목만 대상이 되고, 취소하면 아무것도 바꾸지 않는다', async () => {
    const api = makeApi();
    renderPage(api);
    await ready();
    fireEvent.change(screen.getByLabelText('우선순위 필터'), { target: { value: 'high' } });
    fireEvent.click(screen.getByRole('button', { name: '보이는 1건 완료' }));
    fireEvent.click(await screen.findByRole('button', { name: '취소' }));
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it('조회 전용이면 일괄 완료 버튼이 없다', async () => {
    renderPage(makeApi(), { readOnly: true });
    await ready();
    expect(screen.queryByRole('button', { name: /건 완료$/ })).not.toBeInTheDocument();
  });

  it('일부 실패해도 성공한 건은 유지하고 실패 건수를 알린다', async () => {
    const api = makeApi();
    api.updateTask.mockImplementationOnce(async () => { throw new Error('x'); });
    renderPage(api);
    await ready();
    fireEvent.click(screen.getByRole('button', { name: '보이는 2건 완료' }));
    fireEvent.click(await screen.findByRole('button', { name: '모두 완료' }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: '보이는 1건 완료' })).toBeInTheDocument());
  });
});

describe('TaskPage 라벨·체크리스트(TASK-02)', () => {
  const withChecklist = () => [makeTask(1, { title: '재고 확인', labels: ['재고'], checklist: [{ id: 'a', text: '상자 세기', done: true }, { id: 'b', text: '주문서 작성', done: false }] })];

  it('목록에 라벨과 체크리스트 진행이 보인다', async () => {
    renderPage(makeApi(withChecklist()));
    await ready();
    const row = within(grid()).getByText('재고 확인').closest('tr')!;
    expect(within(row).getByText('1/2')).toBeInTheDocument();
    expect(within(row).getByText('재고')).toBeInTheDocument();
  });

  it('항목을 체크·추가·삭제하면 그때마다 checklist만 저장한다', async () => {
    const api = makeApi(withChecklist());
    renderPage(api);
    await ready();
    fireEvent.click(within(grid()).getByText('재고 확인'));
    const box = () => screen.getByRole('region', { name: '체크리스트' });
    fireEvent.click(within(box()).getByRole('checkbox', { name: '주문서 작성' }));
    await waitFor(() => expect(api.updateTask).toHaveBeenLastCalledWith(ORG, expect.any(String), { checklist: [{ id: 'a', text: '상자 세기', done: true }, { id: 'b', text: '주문서 작성', done: true }] }));
    fireEvent.change(within(box()).getByLabelText('체크리스트 항목'), { target: { value: '택배 확인' } });
    fireEvent.click(within(box()).getByRole('button', { name: '추가' }));
    await waitFor(() => expect(within(box()).getByText('택배 확인')).toBeInTheDocument());
    fireEvent.click(within(box()).getByRole('button', { name: '상자 세기 삭제' }));
    await waitFor(() => expect(within(box()).queryByText('상자 세기')).not.toBeInTheDocument());
    expect(within(box()).getByRole('heading', { name: '체크리스트 (1/2)' })).toBeInTheDocument();
  });

  it('저장에 실패하면 오류를 알리고 항목 상태를 바꾸지 않는다', async () => {
    const api = makeApi(withChecklist());
    api.updateTask.mockImplementationOnce(async () => { throw new Error('x'); });
    renderPage(api);
    await ready();
    fireEvent.click(within(grid()).getByText('재고 확인'));
    fireEvent.click(screen.getByRole('checkbox', { name: '주문서 작성' }));
    expect(await screen.findByText('체크리스트를 저장하지 못했습니다. 다시 시도하세요.')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: '주문서 작성' })).not.toBeChecked();
  });

  it('라벨을 쉼표로 입력해 저장한다', async () => {
    const api = makeApi(withChecklist());
    renderPage(api);
    await ready();
    fireEvent.click(within(grid()).getByText('재고 확인'));
    fireEvent.change(within(detail()).getByLabelText('라벨'), { target: { value: '재고, 월말, 재고' } });
    fireEvent.click(within(detail()).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ORG, expect.any(String), expect.objectContaining({ labels: ['재고', '월말'] })));
  });

  it('조회 전용이면 체크박스는 보이지만 바꿀 수 없다', async () => {
    renderPage(makeApi(withChecklist()), { readOnly: true });
    await ready();
    fireEvent.click(within(grid()).getByText('재고 확인'));
    expect(screen.getByRole('checkbox', { name: '주문서 작성' })).toBeDisabled();
    expect(screen.queryByLabelText('체크리스트 항목')).not.toBeInTheDocument();
  });
});

describe('TaskPage 반복·고객 연결(TASK-01)', () => {
  it('기한이 있는 할 일에 반복과 고객을 지정해 저장한다', async () => {
    const api = makeApi();
    renderPage(api);
    await ready();
    fireEvent.click(within(grid()).getByText('재고 확인'));
    fireEvent.change(within(detail()).getByLabelText('반복'), { target: { value: 'weekly' } });
    fireEvent.change(await within(detail()).findByLabelText('고객'), { target: { value: CUSTOMER } });
    fireEvent.click(within(detail()).getByRole('button', { name: '저장' }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalledWith(ORG, expect.any(String), expect.objectContaining({ recurrence: 'weekly', customer_id: CUSTOMER })));
    await waitFor(() => expect(within(grid()).getByText(/↻ 매주/)).toBeInTheDocument());
  });

  it('기한이 없으면 반복을 저장하지 않고 안내한다', async () => {
    const api = makeApi();
    renderPage(api);
    await ready();
    fireEvent.click(within(grid()).getByText('청소'));
    fireEvent.change(within(detail()).getByLabelText('반복'), { target: { value: 'daily' } });
    fireEvent.click(within(detail()).getByRole('button', { name: '저장' }));
    expect(await within(detail()).findByText('반복하려면 기한을 정해 주세요.')).toBeInTheDocument();
    expect(api.updateTask).not.toHaveBeenCalled();
  });

  it('반복 할 일을 완료하면 목록을 다시 읽어 다음 할 일을 보여 준다', async () => {
    const api = makeApi([makeTask(1, { title: '정기 점검', due_at: local(2026, 10, 15, 10), recurrence: 'weekly' })]);
    renderPage(api);
    await screen.findByText('정기 점검', { selector: 'td' });
    expect(api.listTasks).toHaveBeenCalledTimes(1);
    fireEvent.click(within(grid()).getByText('정기 점검'));
    fireEvent.click(within(detail()).getByRole('button', { name: '완료' }));
    await waitFor(() => expect(api.listTasks).toHaveBeenCalledTimes(2));
  });

  it('반복이 없는 할 일을 완료해도 목록을 다시 읽지 않는다', async () => {
    const api = makeApi();
    renderPage(api);
    await ready();
    fireEvent.click(within(grid()).getByText('재고 확인'));
    fireEvent.click(within(detail()).getByRole('button', { name: '완료' }));
    await waitFor(() => expect(api.updateTask).toHaveBeenCalled());
    expect(api.listTasks).toHaveBeenCalledTimes(1);
  });

  it('조회 전용이면 반복·고객을 바꿀 수 없다', async () => {
    renderPage(makeApi(), { readOnly: true });
    await ready();
    fireEvent.click(within(grid()).getByText('재고 확인'));
    expect(within(detail()).getByLabelText('반복')).toBeDisabled();
  });
});
