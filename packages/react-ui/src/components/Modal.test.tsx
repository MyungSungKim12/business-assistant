import { useRef, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog, confirm } from './ConfirmDialog';
import { DateField } from './DateField';
import { DateRangeField } from './DateRangeField';
import { DateTimeField } from './DateTimeField';
import { Modal } from './Modal';
import { NoticeHost } from './NoticeHost';
import { Select } from './Select';
import { ErrorState } from './States';
import { notify } from './notices';

function ModalHarness({ closeOnBackdrop = false }: { closeOnBackdrop?: boolean }) {
  const [open, setOpen] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        열기
      </button>
      {open && (
        <Modal title="고객 등록" onClose={() => setOpen(false)} closeOnBackdrop={closeOnBackdrop} initialFocusRef={first}>
          <input ref={first} aria-label="고객명" />
          <button type="button">저장</button>
        </Modal>
      )}
    </>
  );
}

describe('common controls', () => {
  it('moves focus into a modal and restores it after Escape', async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);

    const trigger = screen.getByRole('button', { name: '열기' });
    await user.click(trigger);
    expect(screen.getByLabelText('고객명')).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps focus inside the modal while tabbing', async () => {
    const user = userEvent.setup();
    render(<ModalHarness />);
    await user.click(screen.getByRole('button', { name: '열기' }));

    await user.tab();
    expect(screen.getByRole('button', { name: '저장' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: '닫기' })).toHaveFocus();
    await user.tab();
    expect(screen.getByLabelText('고객명')).toHaveFocus();
  });

  it('honors the backdrop close policy', async () => {
    const user = userEvent.setup();
    const { rerender } = render(<ModalHarness />);
    await user.click(screen.getByRole('button', { name: '열기' }));
    await user.click(screen.getByTestId('modal-backdrop'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();

    rerender(<ModalHarness closeOnBackdrop />);
    await user.click(screen.getByTestId('modal-backdrop'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('resolves confirmation with the selected action', async () => {
    const user = userEvent.setup();
    render(<ConfirmDialog />);

    const result = confirm({ title: '변경 취소', message: '입력을 버릴까요?', confirmLabel: '버리기' });
    await user.click(await screen.findByRole('button', { name: '버리기' }));
    await expect(result).resolves.toBe(true);
  });

  it('uses accessible native selection and emits ISO dates only', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onDate = vi.fn();
    render(
      <>
        <Select
          aria-label="피부 타입"
          value="dry"
          options={[
            { value: 'dry', label: '건성' },
            { value: 'oily', label: '지성' },
          ]}
          onChange={onSelect}
        />
        <DateField aria-label="방문일" value="2026-10-12" onChange={onDate} />
      </>,
    );

    await user.selectOptions(screen.getByLabelText('피부 타입'), 'oily');
    expect(onSelect).toHaveBeenCalledWith('oily');
    await user.clear(screen.getByLabelText('방문일'));
    expect(onDate).toHaveBeenLastCalledWith(null);
  });

  it('emits local date-time and date range values', async () => {
    const user = userEvent.setup();
    const onDateTime = vi.fn();
    const onRange = vi.fn();
    render(
      <>
        <DateTimeField aria-label="예약 시각" value="2026-10-12T14:30" onChange={onDateTime} />
        <DateRangeField value={{ from: '2026-10-01', to: null }} onChange={onRange} />
      </>,
    );
    await user.clear(screen.getByLabelText('예약 시각'));
    expect(onDateTime).toHaveBeenLastCalledWith(null);
    await user.type(screen.getByLabelText('종료일'), '2026-10-31');
    expect(onRange).toHaveBeenLastCalledWith({ from: '2026-10-01', to: '2026-10-31' });
  });

  it('keeps errors visible and exposes a retry action', async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(<ErrorState message="고객을 불러오지 못했습니다." onRetry={retry} />);
    expect(screen.getByRole('alert')).toHaveTextContent('고객을 불러오지 못했습니다.');
    await user.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('shows and dismisses persistent error notices', async () => {
    const user = userEvent.setup();
    render(<NoticeHost />);
    notify.error('사진 업로드에 실패했습니다.');
    expect(await screen.findByRole('alert')).toHaveTextContent('사진 업로드에 실패했습니다.');
    await user.click(screen.getByRole('button', { name: '알림 닫기' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
