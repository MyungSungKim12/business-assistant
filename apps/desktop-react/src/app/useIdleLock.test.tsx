import { act, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useIdleLock } from './useIdleLock';

const minutes = (value: number) => value * 60_000;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-13T09:00:00+09:00')); });
afterEach(() => { vi.useRealTimers(); });

describe('useIdleLock', () => {
  it('설정한 시간 동안 입력이 없으면 잠근다', () => {
    const { result } = renderHook(() => useIdleLock(5, true));
    act(() => { vi.advanceTimersByTime(minutes(4)); });
    expect(result.current.locked).toBe(false);
    act(() => { vi.advanceTimersByTime(minutes(1) + 5_000); });
    expect(result.current.locked).toBe(true);
  });

  it('마우스·키 입력은 타이머를 새로 시작한다', () => {
    const { result } = renderHook(() => useIdleLock(5, true));
    act(() => { vi.advanceTimersByTime(minutes(4)); });
    fireEvent.keyDown(window, { key: 'a' });
    act(() => { vi.advanceTimersByTime(minutes(4)); });
    expect(result.current.locked).toBe(false);
    fireEvent.mouseDown(window);
    act(() => { vi.advanceTimersByTime(minutes(4)); });
    expect(result.current.locked).toBe(false);
    act(() => { vi.advanceTimersByTime(minutes(2)); });
    expect(result.current.locked).toBe(true);
  });

  it('끔(0분)이거나 비활성이면 잠기지 않는다', () => {
    const off = renderHook(() => useIdleLock(0, true));
    const disabled = renderHook(() => useIdleLock(5, false));
    act(() => { vi.advanceTimersByTime(minutes(60)); });
    expect(off.result.current.locked).toBe(false);
    expect(disabled.result.current.locked).toBe(false);
  });

  it('잠긴 동안의 입력으로는 풀리지 않고 해제하면 타이머가 다시 시작된다', () => {
    const { result } = renderHook(() => useIdleLock(5, true));
    act(() => { vi.advanceTimersByTime(minutes(6)); });
    expect(result.current.locked).toBe(true);
    fireEvent.keyDown(window, { key: 'a' });
    expect(result.current.locked).toBe(true);
    act(() => { result.current.unlock(); });
    expect(result.current.locked).toBe(false);
    act(() => { vi.advanceTimersByTime(minutes(4)); });
    expect(result.current.locked).toBe(false);
    act(() => { vi.advanceTimersByTime(minutes(2)); });
    expect(result.current.locked).toBe(true);
  });

  it('숨겨진 창에서 타이머가 멈췄다가 다시 보일 때 경과 시간을 확인해 잠근다', () => {
    let current = Date.now();
    const clock = () => current;
    const { result } = renderHook(() => useIdleLock(5, true, clock));
    current += minutes(30);
    expect(result.current.locked).toBe(false);
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(result.current.locked).toBe(true);
  });

  it('즉시 잠그기(lock)는 활성일 때만 동작한다', () => {
    const on = renderHook(() => useIdleLock(5, true));
    const off = renderHook(() => useIdleLock(0, true));
    act(() => { on.result.current.lock(); off.result.current.lock(); });
    expect(on.result.current.locked).toBe(true);
    expect(off.result.current.locked).toBe(false);
  });

  it('설정을 끄면 잠금이 풀린다', () => {
    const { result, rerender } = renderHook(({ value }) => useIdleLock(value, true), { initialProps: { value: 5 } });
    act(() => { vi.advanceTimersByTime(minutes(6)); });
    expect(result.current.locked).toBe(true);
    rerender({ value: 0 });
    expect(result.current.locked).toBe(false);
  });
});
