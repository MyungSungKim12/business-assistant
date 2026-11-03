import { afterEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it('renders caller data as text, does not replay the entrance on refresh, and dispatches memo action', async () => {
  vi.useFakeTimers();
  document.body.innerHTML = '<main id="calls"></main><p id="status"></p>';
  const calls = [{ id: 'event', title: '<img src=x onerror=alert(1)>', phone: '+827012345678', expiresAt: Date.now() + 120_000 }];
  native.invoke.mockImplementation(async command => command === 'call_popup_read' ? calls : undefined);
  await import('./popup-entry');
  expect(document.querySelector('strong')?.textContent).toBe(calls[0]!.title);
  expect(document.querySelector('img')).toBeNull();
  const changes: MutationRecord[] = [];
  const observer = new MutationObserver(records => changes.push(...records));
  observer.observe(document.querySelector('#calls')!, { childList: true });
  await vi.advanceTimersByTimeAsync(1000);
  expect(changes).toHaveLength(0);
  document.querySelector('button')!.click();
  await vi.advanceTimersByTimeAsync(0);
  expect(native.invoke).toHaveBeenCalledWith('call_popup_action', { id: 'event', memo: true });
  await vi.advanceTimersByTimeAsync(120_000);
  expect(document.querySelector('strong')).toBeNull();
  observer.disconnect();
});
