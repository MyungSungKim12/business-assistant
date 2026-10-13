import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES, preferencesKey, readPreferences, sanitizePreferences, usePreferences } from './preferences';

beforeEach(() => {
  localStorage.clear();
  usePreferences.getState().load(null);
});

describe('preferences', () => {
  it('기본값은 모두 끔이다', () => {
    expect(readPreferences('u1')).toEqual(DEFAULT_PREFERENCES);
    expect(DEFAULT_PREFERENCES).toEqual({ maskPhone: false, idleLockMinutes: 0 });
  });

  it('사용자별로 저장하고 다시 불러온다', () => {
    const store = usePreferences.getState();
    store.load('u1');
    usePreferences.getState().setMaskPhone(true);
    usePreferences.getState().setIdleLockMinutes(10);
    expect(JSON.parse(localStorage.getItem(preferencesKey('u1'))!)).toEqual({ maskPhone: true, idleLockMinutes: 10 });
    usePreferences.getState().load('u2');
    expect(usePreferences.getState()).toMatchObject({ maskPhone: false, idleLockMinutes: 0 });
    usePreferences.getState().load('u1');
    expect(usePreferences.getState()).toMatchObject({ maskPhone: true, idleLockMinutes: 10 });
  });

  it('사용자 없이는 저장하지 않는다', () => {
    usePreferences.getState().setMaskPhone(true);
    expect(localStorage.length).toBe(0);
    expect(usePreferences.getState().maskPhone).toBe(true);
  });

  it('잘못된 저장 값은 기본값으로 바로잡는다', () => {
    expect(sanitizePreferences({ maskPhone: 'yes', idleLockMinutes: 7 })).toEqual(DEFAULT_PREFERENCES);
    expect(sanitizePreferences(null)).toEqual(DEFAULT_PREFERENCES);
    localStorage.setItem(preferencesKey('u1'), '{broken');
    expect(readPreferences('u1')).toEqual(DEFAULT_PREFERENCES);
  });

  it('저장소가 막혀 있어도 오류 없이 동작한다', () => {
    usePreferences.getState().load('u1');
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    expect(() => usePreferences.getState().setMaskPhone(true)).not.toThrow();
    expect(usePreferences.getState().maskPhone).toBe(true);
    spy.mockRestore();
  });
});
