import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PhotoGallery } from './PhotoGallery';

const org = '22222222-2222-4222-8222-222222222222';
const cust = '11111111-1111-4111-8111-111111111111';
const photo = (id: string, name: string, createdAt: string) => ({ id, organization_id: org, customer_id: cust, original_name: name, storage_path: 'a', content_type: 'image/jpeg', size_bytes: 10, caption: '', created_at: createdAt });
const p1 = photo('33333333-3333-4333-8333-333333333331', 'a.jpg', '2026-10-13T05:00:00Z');
const p2 = photo('33333333-3333-4333-8333-333333333332', 'b.jpg', '2026-10-13T01:00:00Z');
const p3 = photo('33333333-3333-4333-8333-333333333333', 'c.jpg', '2026-09-01T01:00:00Z');

function makeApi() {
  const items = [p1, p2, p3];
  return {
    listCustomerPhotos: vi.fn(async () => items),
    createPhotoDownloadUrl: vi.fn(async (_o: string, _c: string, id: string) => ({ photo: items.find((item) => item.id === id), signed_url: `https://files.test/${id}`, expires_in: 60 })),
    archiveCustomerPhoto: vi.fn(async (_o: string, _c: string, id: string) => items.find((item) => item.id === id)),
    filePlatform: { pickImages: vi.fn(async () => []), uploadBinary: vi.fn(async () => undefined), downloadBinary: vi.fn(async () => new Uint8Array([1])) },
  };
}

const renderGallery = (client: ReturnType<typeof makeApi>, readOnly = false, size: 'compact' | 'large' = 'compact') =>
  render(<><PhotoGallery api={client as never} organizationId={org} customerId={cust} readOnly={readOnly} size={size} /><ConfirmDialog /></>);

async function confirmDelete() {
  const dialog = (await screen.findByText(/목록에서 사라집니다/)).closest('[role="dialog"]') as HTMLElement;
  fireEvent.click(within(dialog).getByRole('button', { name: '삭제' }));
}

describe('photo deletion', () => {
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
  });

  it.each(['compact', 'large'] as const)('deletes a single photo from its thumbnail corner button (%s size)', async (size) => {
    const client = makeApi();
    renderGallery(client, false, size);
    fireEvent.click(await screen.findByLabelText('b.jpg 삭제'));
    await confirmDelete();
    await waitFor(() => expect(client.archiveCustomerPhoto).toHaveBeenCalledWith(org, cust, p2.id));
    await waitFor(() => expect(screen.queryByLabelText('b.jpg 크게 보기')).not.toBeInTheDocument());
    expect(screen.getByLabelText('a.jpg 크게 보기')).toBeInTheDocument();
  });

  it('does not delete when the confirmation is cancelled', async () => {
    const client = makeApi();
    renderGallery(client);
    fireEvent.click(await screen.findByLabelText('a.jpg 삭제'));
    fireEvent.click(await screen.findByRole('button', { name: '취소' }));
    expect(client.archiveCustomerPhoto).not.toHaveBeenCalled();
    expect(screen.getByLabelText('a.jpg 크게 보기')).toBeInTheDocument();
  });

  it('selects several photos and deletes them with one confirmation', async () => {
    const client = makeApi();
    renderGallery(client);
    await screen.findByLabelText('a.jpg 크게 보기');
    fireEvent.click(screen.getByRole('button', { name: '선택' }));
    expect(screen.getByRole('button', { name: '선택 삭제' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('a.jpg 선택'));
    fireEvent.click(screen.getByLabelText('c.jpg 선택'));
    expect(screen.getByText('2장 선택')).toBeInTheDocument();
    expect(screen.queryByLabelText('a.jpg 삭제')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '선택 삭제' }));
    expect(await screen.findByText(/선택한 사진 2장을 삭제하시겠습니까/)).toBeInTheDocument();
    await confirmDelete();
    await waitFor(() => expect(client.archiveCustomerPhoto).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByLabelText('a.jpg 선택')).not.toBeInTheDocument());
    expect(screen.getByLabelText('b.jpg 크게 보기')).toBeInTheDocument();
    expect(screen.queryByText(/장 선택/)).not.toBeInTheDocument();
  });

  it('keeps only the failed photos selected when part of a bulk delete fails', async () => {
    const client = makeApi();
    client.archiveCustomerPhoto.mockImplementation(async (_o: string, _c: string, id: string) => {
      if (id === p2.id) throw new Error('503');
      return p1;
    });
    renderGallery(client);
    await screen.findByLabelText('a.jpg 크게 보기');
    fireEvent.click(screen.getByRole('button', { name: '선택' }));
    fireEvent.click(screen.getByRole('button', { name: '전체 선택' }));
    expect(screen.getByText('3장 선택')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '선택 삭제' }));
    await confirmDelete();
    expect(await screen.findByText('1장을 삭제하지 못했습니다. 다시 시도해 주세요.')).toBeInTheDocument();
    expect(screen.getByText('1장 선택')).toBeInTheDocument();
    expect(screen.getByLabelText('b.jpg 선택')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByLabelText('a.jpg 선택')).not.toBeInTheDocument();
  });

  it('can leave selection mode without deleting', async () => {
    const client = makeApi();
    renderGallery(client);
    await screen.findByLabelText('a.jpg 크게 보기');
    fireEvent.click(screen.getByRole('button', { name: '선택' }));
    fireEvent.click(screen.getByLabelText('a.jpg 선택'));
    fireEvent.click(screen.getByRole('button', { name: '선택 취소' }));
    expect(screen.getByRole('button', { name: '사진 추가' })).toBeInTheDocument();
    expect(client.archiveCustomerPhoto).not.toHaveBeenCalled();
  });

  it('hides every delete control for read-only users', async () => {
    renderGallery(makeApi(), true);
    await screen.findByLabelText('a.jpg 크게 보기');
    expect(screen.queryByRole('button', { name: '선택' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('a.jpg 삭제')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '사진 추가' })).not.toBeInTheDocument();
  });
});
