import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { ApiError } from '../../api/errors';
import type { ApiClient } from '../../api/client';
import type { CustomerPhoto } from '../../api/schemas';
import type { TreatmentPhoto } from './api';
import { TreatmentPhotoLinks } from './TreatmentPhotoLinks';

const org = '22222222-2222-4222-8222-222222222222';
const cust = '11111111-1111-4111-8111-111111111111';
const treatment = '44444444-4444-4444-8444-444444444444';

const photo = (n: number, extra: Partial<CustomerPhoto> = {}): CustomerPhoto => ({
  id: `a000000${n}-0000-4000-8000-000000000000`, organization_id: org, customer_id: cust, original_name: `사진${n}.jpg`, storage_path: `${org}/photo-${n}.jpg`,
  content_type: 'image/jpeg', size_bytes: 100, caption: '', created_at: '2026-09-18T01:00:00Z', ...extra,
});
const link = (n: number, extra: Partial<TreatmentPhoto> = {}): TreatmentPhoto => ({
  id: `b000000${n}-0000-4000-8000-000000000000`, organization_id: org, customer_id: cust, treatment_id: treatment, storage_path: `${org}/photo-${n}.jpg`, thumbnail_path: null,
  content_type: 'image/jpeg', caption: '', sort_order: 0, taken_at: null, phase: null, ...extra,
});

type Call = { method: string; path: string; body: unknown };

function setup(options: { links?: TreatmentPhoto[]; photos?: CustomerPhoto[]; readOnly?: boolean; handler?: (call: Call) => unknown } = {}) {
  const state = { links: options.links ?? [] };
  const calls: Call[] = [];
  const call = vi.fn(async (method: string, path: string, schema: z.ZodType, body?: unknown) => {
    const entry = { method, path, body };
    calls.push(entry);
    const custom = options.handler?.(entry);
    if (custom !== undefined) return schema.parse(custom);
    if (method === 'GET' && path.includes('/treatment-photos')) return schema.parse(state.links);
    if (method === 'POST' && path.endsWith('/treatment-photos')) {
      const input = body as { storage_path: string; phase?: TreatmentPhoto['phase']; caption?: string; sort_order?: number };
      const created = link(state.links.length + 5, { ...input, phase: input.phase ?? null });
      state.links = [...state.links, created];
      return schema.parse(created);
    }
    if (method === 'PATCH') {
      const id = path.split('/').pop()!;
      const patch = body as Partial<TreatmentPhoto>;
      state.links = state.links.map((item) => (item.id === id ? { ...item, ...patch } : item));
      return schema.parse(state.links.find((item) => item.id === id));
    }
    if (method === 'DELETE') {
      const id = path.split('/').pop()!;
      state.links = state.links.filter((item) => item.id !== id);
      return schema.parse(undefined);
    }
    throw new ApiError(404, 'HTTP_404', 'not found', false);
  });
  const api = {
    call,
    callVoid: vi.fn(async (method: string, path: string) => { await call(method, path, { parse: () => undefined } as unknown as z.ZodType); }),
    listCustomerPhotos: vi.fn(async () => options.photos ?? [photo(1), photo(2), photo(3)]),
    createPhotoDownloadUrl: vi.fn(async (_o: string, _c: string, id: string) => ({ photo: {}, signed_url: `https://files.test/${id}`, expires_in: 60 })),
    filePlatform: { downloadBinary: vi.fn(async () => new Uint8Array([1, 2, 3])) },
  } as unknown as ApiClient;
  const view = render(<><TreatmentPhotoLinks api={api} organizationId={org} customerId={cust} treatmentId={treatment} treatmentLabel="수분 관리 · 2026-09-18" readOnly={options.readOnly ?? false} /><ConfirmDialog /></>);
  return { api, calls, view, state };
}

beforeEach(() => {
  let counter = 0;
  Object.assign(URL, { createObjectURL: vi.fn(() => `blob:photo-${counter++}`), revokeObjectURL: vi.fn() });
});

const section = (name: string) => screen.getByRole('region', { name });

describe('TreatmentPhotoLinks · 목록', () => {
  it('연결된 사진을 시술 전/후/기타로 나눠 보여 주고 원본이 없는 연결은 표시한다', async () => {
    setup({ links: [link(1, { phase: 'before' }), link(2, { phase: 'after' }), link(3), link(9, { phase: 'after' })] });
    expect(await screen.findByRole('region', { name: '시술 전 사진' })).toBeInTheDocument();
    expect(within(section('시술 전 사진')).getByText('사진1.jpg')).toBeInTheDocument();
    expect(within(section('시술 후 사진')).getByText('사진2.jpg')).toBeInTheDocument();
    expect(within(section('시술 후 사진')).getByText('원본 사진 없음')).toBeInTheDocument();
    expect(within(section('기타 사진')).getByText('사진3.jpg')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /수분 관리 · 2026-09-18/ })).toBeInTheDocument();
  });

  it('연결된 사진이 없으면 안내하고 비교 버튼은 꺼 둔다', async () => {
    setup();
    expect(await screen.findByText(/연결된 사진이 없습니다/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '전/후 비교' })).toBeDisabled();
  });

  it('시술 전 또는 후 한쪽만 있으면 비교할 수 없다', async () => {
    setup({ links: [link(1, { phase: 'before' })] });
    await screen.findByRole('region', { name: '시술 전 사진' });
    expect(screen.getByRole('button', { name: '전/후 비교' })).toBeDisabled();
  });

  it('불러오기에 실패하면 안내와 다시 불러오기를 보인다', async () => {
    let fail = true;
    setup({ links: [link(1, { phase: 'before' })], handler: (call) => { if (fail && call.method === 'GET') throw new ApiError(500, 'HTTP_500', 'x', true); return undefined; } });
    expect(await screen.findByText(/시술 전\/후 사진을 불러오지 못했습니다/)).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: '전/후 사진 다시 불러오기' }));
    expect(await screen.findByRole('region', { name: '시술 전 사진' })).toBeInTheDocument();
  });
});

describe('TreatmentPhotoLinks · 연결·변경·해제', () => {
  it('고객 사진에서 골라 시술 전으로 연결한다(저장 경로를 재사용하고 중복 업로드 없음)', async () => {
    const { calls, api } = setup({ links: [link(3, { phase: 'after' })] });
    await screen.findByRole('region', { name: '시술 후 사진' });
    fireEvent.click(screen.getByRole('button', { name: '사진 연결' }));
    const dialog = await screen.findByRole('dialog', { name: /시술 사진 연결/ });
    // 이미 연결된 사진3 은 후보에서 빠진다.
    expect(within(dialog).queryByRole('button', { name: '사진3.jpg 선택' })).not.toBeInTheDocument();
    fireEvent.click(await within(dialog).findByRole('button', { name: '사진1.jpg 선택' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '사진2.jpg 선택' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('2장 선택');
    fireEvent.click(within(dialog).getByRole('button', { name: '시술 전 사진으로 연결' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const posts = calls.filter((entry) => entry.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toMatchObject({ treatment_id: treatment, storage_path: photo(1).storage_path, content_type: 'image/jpeg', phase: 'before', sort_order: 0, taken_at: photo(1).created_at });
    expect(posts[1].body).toMatchObject({ storage_path: photo(2).storage_path, phase: 'before', sort_order: 1 });
    expect(posts[0].path).toBe(`/organizations/${org}/customers/${cust}/treatment-photos`);
    expect(within(await screen.findByRole('region', { name: '시술 전 사진' })).getAllByRole('listitem')).toHaveLength(2);
    // 업로드(upload-url) 호출은 없다.
    expect(calls.some((entry) => entry.path.includes('upload-url'))).toBe(false);
    expect((api.filePlatform as unknown as { uploadBinary?: unknown }).uploadBinary).toBeUndefined();
  });

  it('시술 후로 연결할 구분을 고를 수 있다', async () => {
    const { calls } = setup();
    await screen.findByText(/연결된 사진이 없습니다/);
    fireEvent.click(screen.getByRole('button', { name: '사진 연결' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: '시술 후' }));
    fireEvent.click(await within(dialog).findByRole('button', { name: '사진1.jpg 선택' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '시술 후 사진으로 연결' }));
    await waitFor(() => expect(calls.some((entry) => entry.method === 'POST')).toBe(true));
    expect(calls.find((entry) => entry.method === 'POST')!.body).toMatchObject({ phase: 'after' });
  });

  it('일부만 연결에 실패하면 성공한 사진은 남기고 실패 수를 알린다', async () => {
    let attempts = 0;
    setup({ handler: (call) => { if (call.method === 'POST') { attempts += 1; if (attempts === 2) throw new ApiError(422, 'HTTP_422', 'x', false); } return undefined; } });
    await screen.findByText(/연결된 사진이 없습니다/);
    fireEvent.click(screen.getByRole('button', { name: '사진 연결' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(await within(dialog).findByRole('button', { name: '사진1.jpg 선택' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '사진2.jpg 선택' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '시술 전 사진으로 연결' }));
    expect(await screen.findByText(/1장을 연결하지 못했습니다/)).toBeInTheDocument();
    expect(within(await screen.findByRole('region', { name: '시술 전 사진' })).getAllByRole('listitem')).toHaveLength(1);
  });

  it('연결할 고객 사진이 없으면 안내한다', async () => {
    setup({ photos: [] });
    await screen.findByText(/연결된 사진이 없습니다/);
    fireEvent.click(screen.getByRole('button', { name: '사진 연결' }));
    expect(await screen.findByText(/연결할 수 있는 고객 사진이 없습니다/)).toBeInTheDocument();
  });

  it('구분을 바꾸면 PATCH 로 phase 만 보낸다', async () => {
    const { calls } = setup({ links: [link(1, { phase: 'before' })] });
    const select = await screen.findByRole('combobox', { name: '사진1.jpg 구분' });
    fireEvent.change(select, { target: { value: 'after' } });
    await waitFor(() => expect(within(screen.getByRole('region', { name: '시술 후 사진' })).getByText('사진1.jpg')).toBeInTheDocument());
    const patch = calls.find((entry) => entry.method === 'PATCH')!;
    expect(patch.path).toBe(`/organizations/${org}/customers/${cust}/treatment-photos/${link(1).id}`);
    expect(patch.body).toEqual({ phase: 'after' });
  });

  it('연결 해제는 확인 후 연결만 지운다', async () => {
    const { calls } = setup({ links: [link(1, { phase: 'before' })] });
    fireEvent.click(await screen.findByRole('button', { name: '사진1.jpg 연결 해제' }));
    const confirmDialog = await screen.findByRole('dialog', { name: '사진 연결 해제' });
    expect(confirmDialog).toHaveTextContent('고객 사진은 삭제되지 않습니다');
    fireEvent.click(within(confirmDialog).getByRole('button', { name: '해제' }));
    await waitFor(() => expect(screen.queryByRole('region', { name: '시술 전 사진' })).not.toBeInTheDocument());
    expect(calls.filter((entry) => entry.method === 'DELETE')).toHaveLength(1);
    expect(calls.some((entry) => entry.path.includes('/photos/'))).toBe(false);
  });

  it('해제를 취소하면 아무것도 하지 않는다', async () => {
    const { calls } = setup({ links: [link(1, { phase: 'before' })] });
    fireEvent.click(await screen.findByRole('button', { name: '사진1.jpg 연결 해제' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: '사진 연결 해제' })).getByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(calls.some((entry) => entry.method === 'DELETE')).toBe(false);
  });

  it('권한이 없으면(403) 안내하고 목록은 그대로 둔다', async () => {
    setup({ links: [link(1, { phase: 'before' })], handler: (call) => { if (call.method === 'PATCH') throw new ApiError(403, 'HTTP_403', 'x', false); return undefined; } });
    fireEvent.change(await screen.findByRole('combobox', { name: '사진1.jpg 구분' }), { target: { value: 'after' } });
    expect(await screen.findByText(/관리자만 가능/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: '시술 전 사진' })).getByText('사진1.jpg')).toBeInTheDocument();
  });

  it('읽기 전용(멤버)은 연결·구분 변경·해제 없이 조회와 비교만 한다', async () => {
    setup({ readOnly: true, links: [link(1, { phase: 'before' }), link(2, { phase: 'after' })] });
    await screen.findByRole('region', { name: '시술 전 사진' });
    expect(screen.queryByRole('button', { name: '사진 연결' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /연결 해제/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '전/후 비교' })).toBeEnabled();
  });
});

describe('PhotoCompare · 전/후 비교', () => {
  const open = async (extra: Parameters<typeof setup>[0] = {}) => {
    const fake = setup({ links: [link(1, { phase: 'before' }), link(2, { phase: 'after' }), link(3, { phase: 'after', caption: '두번째 후' })], ...extra });
    await screen.findByRole('region', { name: '시술 전 사진' });
    fireEvent.click(screen.getByRole('button', { name: '전/후 비교' }));
    const dialog = await screen.findByRole('dialog', { name: '시술 전/후 비교' });
    return { ...fake, dialog };
  };

  it('기본은 좌우 나란히 보기이고 두 사진을 같은 크기의 틀에 불러온다', async () => {
    const { dialog } = await open();
    expect(await within(dialog).findByRole('img', { name: '시술 전 사진' })).toBeInTheDocument();
    expect(await within(dialog).findByRole('img', { name: '시술 후 사진' })).toBeInTheDocument();
    expect(within(dialog).getByRole('group', { name: '시술 전 사진' })).toHaveClass('cmp-frame');
    expect(within(dialog).getByRole('group', { name: '시술 후 사진' })).toHaveClass('cmp-frame');
    expect(within(dialog).getByRole('radio', { name: '나란히 보기' })).toBeChecked();
  });

  it('여러 장이면 시술 후 사진을 바꿔 비교한다', async () => {
    const { dialog } = await open();
    await within(dialog).findByRole('img', { name: '시술 후 사진' });
    const select = within(dialog).getByLabelText('시술 후');
    expect(within(select).getAllByRole('option').map((option) => option.textContent)).toEqual(['사진2.jpg', '두번째 후']);
    fireEvent.change(select, { target: { value: link(3).id } });
    expect(within(dialog).getByText(/시술 후 · 두번째 후/)).toBeInTheDocument();
  });

  it('슬라이더 비교로 바꾸면 하나의 틀에 겹쳐 보여 주고 위치를 조절한다', async () => {
    const { dialog } = await open();
    fireEvent.click(within(dialog).getByRole('radio', { name: '슬라이더 비교' }));
    const frame = within(dialog).getByRole('group', { name: '시술 전/후 겹쳐 보기' });
    await waitFor(() => expect(within(frame).getAllByRole('img')).toHaveLength(2));
    const slider = within(dialog).getByRole('slider', { name: '비교 위치' });
    expect(slider).toHaveValue('50');
    fireEvent.change(slider, { target: { value: '20' } });
    expect(frame.querySelector('.cmp-clip')).toHaveStyle({ clipPath: 'inset(0 0 0 20%)' });
  });

  it('확대·축소·맞춤은 두 사진에 같은 배율로 적용된다', async () => {
    const { dialog } = await open();
    await within(dialog).findByRole('img', { name: '시술 후 사진' });
    expect(within(dialog).getByRole('status')).toHaveTextContent('100%');
    expect(within(dialog).getByRole('button', { name: '축소' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '확대' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '확대' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('150%');
    const layers = [...dialog.querySelectorAll<HTMLElement>('.cmp-layer')];
    expect(layers).toHaveLength(2);
    layers.forEach((layer) => expect(layer.style.transform).toContain('scale(1.5)'));
    fireEvent.change(within(dialog).getByRole('slider', { name: '확대 비율' }), { target: { value: '400' } });
    expect(within(dialog).getByRole('button', { name: '확대' })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole('button', { name: '맞춤' }));
    expect(within(dialog).getByRole('status')).toHaveTextContent('100%');
  });

  it('원본이 없는 사진은 비교 대상에서 빠져 비교 버튼이 꺼진다', async () => {
    setup({ links: [link(1, { phase: 'before' }), link(9, { phase: 'after' })] });
    await screen.findByRole('region', { name: '시술 후 사진' });
    expect(screen.getByRole('button', { name: '전/후 비교' })).toBeDisabled();
  });

  it('사진을 불러오지 못하면 틀 안에 안내한다', async () => {
    const { api } = setup({ links: [link(1, { phase: 'before' }), link(2, { phase: 'after' })] });
    (api.filePlatform.downloadBinary as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('network'));
    await screen.findByRole('region', { name: '시술 전 사진' });
    fireEvent.click(screen.getByRole('button', { name: '전/후 비교' }));
    const dialog = await screen.findByRole('dialog', { name: '시술 전/후 비교' });
    await waitFor(() => expect(within(dialog).getAllByText('사진을 불러오지 못했습니다.').length).toBeGreaterThan(0));
  });
});
