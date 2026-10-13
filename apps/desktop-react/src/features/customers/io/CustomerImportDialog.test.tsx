import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Customer } from '../types';
import { CustomerImportDialog } from './CustomerImportDialog';

const picked = vi.hoisted(() => ({ file: null as { name: string; bytes: Uint8Array } | null, error: '' }));
vi.mock('../../../lib/io/fileAccess', async (original) => ({
  ...(await original<typeof import('../../../lib/io/fileAccess')>()),
  pickDataFile: vi.fn(async () => {
    if (picked.error) throw new Error(picked.error);
    return picked.file;
  }),
}));

const org = '22222222-2222-4222-8222-222222222222';
const existing: Customer = {
  id: '11111111-1111-4111-8111-111111111111', organization_id: org, name: '기존고객', email: null, phone: '010-9999-8888', notes: '', birth_date: null,
  skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active',
};
const csv = [
  '이름,연락처,이메일,태그',
  '신규A,010-1111-2222,a@example.com,"VIP, 재방문"',
  '중복B,01099998888,,',
  '오류C,전화아님,,',
  '',
  '신규D,010-3333-4444,,',
].join('\n');

function fakeApi() {
  return {
    createCustomer: vi.fn(async (_org: string, input: object) => ({ ...existing, ...input, id: crypto.randomUUID() })),
    updateCustomer: vi.fn(async (_org: string, id: string, input: object) => ({ ...existing, ...input, id })),
    listCustomers: vi.fn(async () => [existing]),
  };
}

function open(api = fakeApi(), onImported = vi.fn(), onClose = vi.fn()) {
  render(<CustomerImportDialog api={api as never} organizationId={org} existing={[existing]} onClose={onClose} onImported={onImported} />);
  return { api, onImported, onClose };
}

async function loadFile() {
  fireEvent.click(screen.getByRole('button', { name: '파일 선택' }));
  await screen.findByText(/열을 고객 항목에 연결하세요/);
}

beforeEach(() => {
  picked.file = { name: '고객.csv', bytes: new TextEncoder().encode(csv) };
  picked.error = '';
});

describe('CustomerImportDialog', () => {
  it('walks through mapping, validation with duplicates and errors, then registers with skip policy', async () => {
    const { api, onImported } = open();
    await loadFile();
    expect(screen.getByLabelText('이름 항목')).toHaveValue('name');
    expect(screen.getByLabelText('연락처 항목')).toHaveValue('phone');
    expect(screen.getByLabelText('이메일 항목')).toHaveValue('email');
    expect(screen.getByLabelText('태그 항목')).toHaveValue('tags');

    fireEvent.click(screen.getByRole('button', { name: '다음: 검증' }));
    const summary = await screen.findByTestId('plan-summary');
    expect(summary).toHaveTextContent('전체 4행');
    expect(summary).toHaveTextContent('신규 2');
    expect(summary).toHaveTextContent('중복 1');
    expect(summary).toHaveTextContent('오류 1');
    expect(screen.getByText('중복(연락처: 기존고객) → 건너뜀')).toBeInTheDocument();
    expect(screen.getByText(/연락처 형식이 올바르지 않습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '오류 행 내려받기' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '2건 등록 실행' }));
    await waitFor(() => expect(screen.getByTestId('run-summary')).toHaveTextContent('신규 2'));
    expect(screen.getByTestId('run-summary')).toHaveTextContent('건너뜀 1');
    expect(screen.getByTestId('run-summary')).toHaveTextContent('실패 0');
    expect(api.createCustomer).toHaveBeenCalledTimes(2);
    expect(api.updateCustomer).not.toHaveBeenCalled();
    expect(api.createCustomer.mock.calls[0][1]).toMatchObject({ name: '신규A', tags: ['VIP', '재방문'], status: 'active' });
    expect(onImported).toHaveBeenCalled();
  });

  it('overwrites duplicates with PATCH when chosen', async () => {
    const { api } = open();
    await loadFile();
    fireEvent.click(screen.getByRole('button', { name: '다음: 검증' }));
    await screen.findByTestId('plan-summary');
    fireEvent.click(screen.getByLabelText(/덮어쓰기/));
    fireEvent.click(screen.getByRole('button', { name: '3건 등록·덮어쓰기 실행' }));
    await waitFor(() => expect(screen.getByTestId('run-summary')).toHaveTextContent('덮어씀 1'));
    expect(api.updateCustomer).toHaveBeenCalledWith(org, existing.id, { name: '중복B', phone: '01099998888' });
  });

  it('requires a name column', async () => {
    picked.file = { name: 'x.csv', bytes: new TextEncoder().encode('메모\n내용') };
    open();
    await loadFile();
    fireEvent.change(screen.getByLabelText('메모 항목'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: '다음: 검증' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('이름 열을 지정');
  });

  it('shows a file error and stays on step 1', async () => {
    picked.error = '파일은 5MB 이하여야 합니다.';
    open();
    fireEvent.click(screen.getByRole('button', { name: '파일 선택' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('5MB');
    expect(screen.getByRole('button', { name: '파일 선택' })).toBeInTheDocument();
  });

  it('offers retry for failed rows and does not recreate successful ones', async () => {
    const api = fakeApi();
    let fail = true;
    api.createCustomer.mockImplementation(async (_org: string, input: object) => {
      if ((input as { name: string }).name === '신규D' && fail) throw Object.assign(new Error('x'), { status: 0 });
      return { ...existing, ...input, id: crypto.randomUUID() };
    });
    open(api);
    await loadFile();
    fireEvent.click(screen.getByRole('button', { name: '다음: 검증' }));
    await screen.findByTestId('plan-summary');
    fireEvent.click(screen.getByRole('button', { name: '2건 등록 실행' }));
    await waitFor(() => expect(screen.getByTestId('run-summary')).toHaveTextContent('실패 1'));
    const retry = await screen.findByRole('button', { name: /재시도/ });
    fail = false;
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByTestId('run-summary')).toHaveTextContent('실패 0'));
    expect(screen.getByTestId('run-summary')).toHaveTextContent('신규 2');
    expect(api.createCustomer.mock.calls.filter((call) => (call[1] as { name: string }).name === '신규A')).toHaveLength(1);
    expect(within(screen.getByTestId('run-summary')).queryByText(/취소됨/)).toBeNull();
  });
});
