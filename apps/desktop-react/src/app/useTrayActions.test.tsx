import { act, render, screen, waitFor } from '@testing-library/react';
import { ConfirmDialog } from '@business-assistant/react-ui';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Platform } from '../platform/types';
import { useTrayActions } from './useTrayActions';

function setup(signedIn: boolean) {
  let emit: (action: 'logout' | 'exit') => void = () => undefined;
  const release = vi.fn();
  const platform = {
    subscribeTray: vi.fn(async (handler: (action: 'logout' | 'exit') => void) => { emit = handler; return release; }),
    exitApp: vi.fn(async () => undefined),
  } as unknown as Platform;
  const logout = vi.fn(async () => undefined);
  function Harness() { useTrayActions(platform, { signedIn, logout }); return <ConfirmDialog />; }
  const view = render(<Harness />);
  return { platform, logout, release, emit: async (action: 'logout' | 'exit') => { act(() => { void emit(action); }); }, view };
}

describe('tray actions', () => {
  it('asks before exiting from the tray and exits only after confirming', async () => {
    const { platform, emit } = setup(true);
    await waitFor(() => expect(platform.subscribeTray).toHaveBeenCalled());
    await emit('exit');
    await userEvent.click(await screen.findByRole('button', { name: '취소' }));
    expect(platform.exitApp).not.toHaveBeenCalled();
    await emit('exit');
    await userEvent.click(await screen.findByRole('button', { name: '종료' }));
    await waitFor(() => expect(platform.exitApp).toHaveBeenCalledTimes(1));
  });

  it('logs out from the tray only when signed in and confirmed', async () => {
    const signedOut = setup(false);
    await waitFor(() => expect(signedOut.platform.subscribeTray).toHaveBeenCalled());
    await signedOut.emit('logout');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    signedOut.view.unmount();

    const { platform, logout, emit } = setup(true);
    await waitFor(() => expect(platform.subscribeTray).toHaveBeenCalled());
    await emit('logout');
    await userEvent.click(await screen.findByRole('button', { name: '로그아웃' }));
    await waitFor(() => expect(logout).toHaveBeenCalledTimes(1));
  });

  it('releases the tray subscription on unmount', async () => {
    const { platform, release, view } = setup(true);
    await waitFor(() => expect(platform.subscribeTray).toHaveBeenCalled());
    await act(async () => undefined);
    view.unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });
});
