import { render, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { DraftBoundary, useDraftProtection } from './DraftBoundary';

function Editor({ dirty, busy = false }: { dirty: boolean; busy?: boolean }) { useDraftProtection(dirty, busy); return null; }

it('다른 팝업이 닫혀도 남은 편집기의 보호를 유지하고 처리 중 상태를 별도로 전달한다', async () => {
  const dirty = vi.fn(), busy = vi.fn();
  const tree = (popup: boolean, working: boolean) => <DraftBoundary onDirtyChange={dirty} onBusyChange={busy}><Editor dirty={true} />{popup && <Editor dirty={false} busy={working} />}</DraftBoundary>;
  const view = render(tree(true, true));
  await waitFor(() => expect(busy).toHaveBeenLastCalledWith(true));
  view.rerender(tree(false, false));
  await waitFor(() => expect(busy).toHaveBeenLastCalledWith(false));
  expect(dirty).toHaveBeenLastCalledWith(true);
  view.unmount();
  expect(dirty).toHaveBeenLastCalledWith(false);
});
