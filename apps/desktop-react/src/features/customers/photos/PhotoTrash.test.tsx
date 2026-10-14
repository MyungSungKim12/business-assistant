import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmDialog, NoticeHost } from '@business-assistant/react-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../api/errors';
import { PhotoGallery } from './PhotoGallery';
import { formatDeletedAt, formatSize } from './PhotoTrashDialog';

const org = '22222222-2222-4222-8222-222222222222';
const cust = '11111111-1111-4111-8111-111111111111';
const base = (id: string, name: string, createdAt: string) => ({ id, organization_id: org, customer_id: cust, original_name: name, storage_path: 'a', content_type: 'image/jpeg', size_bytes: 2_621_440, caption: '메모', created_at: createdAt });
const live = base('33333333-3333-4333-8333-333333333331', 'live.jpg', '2026-10-13T05:00:00Z');
const t1 = { ...base('33333333-3333-4333-8333-333333333332', 'deleted-a.jpg', '2026-10-01T01:00:00Z'), archived_at: '2026-10-14T05:30:00Z', archived_by_name: '원장' };
const t2 = { ...base('33333333-3333-4333-8333-333333333333', 'deleted-b.jpg', '2026-09-01T01:00:00Z'), archived_at: null, archived_by_name: null };

function makeApi(overrides: Record<string, unknown> = {}) {
  let trash = [t1, t2];
  let items = [live];
  return {
    api: {
      listCustomerPhotos: vi.fn(async () => items),
      listTrashedPhotos: vi.fn(async () => trash),
      restoreCustomerPhoto: vi.fn(async (_o: string, _c: string, id: string) => {
        const found = trash.find((item) => item.id === id)!;
        trash = trash.filter((item) => item.id !== id);
        items = [...items, found];
        return found;
      }),
      createPhotoDownloadUrl: vi.fn(async (_o: string, _c: string, id: string) => ({ photo: live, signed_url: `https://files.test/${id}`, expires_in: 60 })),
      archiveCustomerPhoto: vi.fn(),
      filePlatform: { pickImages: vi.fn(async () => []), uploadBinary: vi.fn(async () => undefined), downloadBinary: vi.fn(async () => new Uint8Array([1])) },
      ...overrides,
    },
  };
}
const renderGallery = (api: unknown, readOnly = false) =>
  render(<><NoticeHost /><PhotoGallery api={api as never} organizationId={org} customerId={cust} readOnly={readOnly} size="compact" /><ConfirmDialog /></>);
const openTrash = async () => { fireEvent.click(await screen.findByRole('button', { name: '휴지통' })); return screen.findByRole('dialog', { name: '사진 휴지통' }); };

describe('고객 사진 휴지통 (CRM-15)', () => {
  beforeEach(() => { URL.createObjectURL = vi.fn(() => 'blob:x'); URL.revokeObjectURL = vi.fn(); });

  it('삭제한 사진의 파일명·크기·삭제 시각(한국 시간)·삭제한 사람을 보여 준다', async () => {
    const { api } = makeApi();
    renderGallery(api);
    const dialog = await openTrash();
    const rows = within(await within(dialog).findByRole('table')).getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('deleted-a.jpg');
    expect(rows[1]).toHaveTextContent('2.5MB');
    expect(rows[1]).toHaveTextContent('2026-10-14 14:30');
    expect(rows[1]).toHaveTextContent('원장');
    expect(rows[2]).toHaveTextContent('알 수 없음');
    expect(api.listTrashedPhotos).toHaveBeenCalledWith(org, cust);
  });

  it('복원하면 휴지통에서 빠지고 갤러리 목록을 다시 읽는다', async () => {
    const { api } = makeApi();
    renderGallery(api);
    const dialog = await openTrash();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'deleted-a.jpg 복원' }));
    await waitFor(() => expect(api.restoreCustomerPhoto).toHaveBeenCalledWith(org, cust, t1.id));
    await waitFor(() => expect(within(dialog).queryByRole('button', { name: 'deleted-a.jpg 복원' })).not.toBeInTheDocument());
    expect(await screen.findByText(/사진을 복원했습니다/)).toBeInTheDocument();
    await waitFor(() => expect(api.listCustomerPhotos.mock.calls.length).toBeGreaterThan(1));
  });

  it('휴지통이 비어 있으면 안내한다', async () => {
    const { api } = makeApi({ listTrashedPhotos: vi.fn(async () => []) });
    renderGallery(api);
    const dialog = await openTrash();
    expect(await within(dialog).findByText('휴지통이 비어 있습니다.')).toBeInTheDocument();
  });

  it('복원 대상이 이미 없으면(404) 안내하고 목록을 다시 읽는다', async () => {
    const { api } = makeApi({ restoreCustomerPhoto: vi.fn(async () => { throw new ApiError(404, 'HTTP_404', 'nf', false); }) });
    renderGallery(api);
    const dialog = await openTrash();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'deleted-a.jpg 복원' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('이미 복원되었거나');
    await waitFor(() => expect(api.listTrashedPhotos.mock.calls.length).toBeGreaterThan(1));
  });

  it('복원 실패는 안내하고 항목은 그대로 둔다', async () => {
    const { api } = makeApi({ restoreCustomerPhoto: vi.fn(async () => { throw new ApiError(503, 'HTTP_503', 'x', true); }) });
    renderGallery(api);
    const dialog = await openTrash();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'deleted-a.jpg 복원' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('복원하지 못했습니다');
    expect(within(dialog).getByRole('button', { name: 'deleted-a.jpg 복원' })).toBeInTheDocument();
  });

  it('권한이 없으면(403) 안내하고, 불러오기 실패는 다시 시도할 수 있다', async () => {
    const forbidden = makeApi({ listTrashedPhotos: vi.fn(async () => { throw new ApiError(403, 'HTTP_403', 'no', false); }) });
    renderGallery(forbidden.api);
    expect(await within(await openTrash()).findByText('휴지통은 소유자·관리자만 볼 수 있습니다.')).toBeInTheDocument();
  });

  it('불러오기에 실패하면 다시 시도할 수 있다', async () => {
    let fail = true;
    const { api } = makeApi({ listTrashedPhotos: vi.fn(async () => { if (fail) throw new ApiError(503, 'HTTP_503', 'x', true); return [t1]; }) });
    renderGallery(api);
    const dialog = await openTrash();
    expect(await within(dialog).findByText('휴지통을 불러오지 못했습니다.')).toBeInTheDocument();
    fail = false;
    fireEvent.click(within(dialog).getByRole('button', { name: '다시 시도' }));
    expect(await within(dialog).findByRole('button', { name: 'deleted-a.jpg 복원' })).toBeInTheDocument();
  });

  it('조회 전용 구성원에게는 휴지통 버튼이 없다', async () => {
    const { api } = makeApi();
    renderGallery(api, true);
    await screen.findByLabelText('live.jpg 크게 보기');
    expect(screen.queryByRole('button', { name: '휴지통' })).not.toBeInTheDocument();
    expect(api.listTrashedPhotos).not.toHaveBeenCalled();
  });

  it('시각·크기 표시 도우미', () => {
    expect(formatDeletedAt('2026-10-14T05:30:00Z')).toBe('2026-10-14 14:30');
    expect(formatDeletedAt('2026-10-14T16:00:00Z')).toBe('2026-10-15 01:00');
    expect(formatDeletedAt(null)).toBe('알 수 없음');
    expect(formatDeletedAt('bad')).toBe('알 수 없음');
    expect(formatSize(500)).toBe('1KB');
    expect(formatSize(300 * 1024)).toBe('300KB');
    expect(formatSize(2_621_440)).toBe('2.5MB');
  });
});
