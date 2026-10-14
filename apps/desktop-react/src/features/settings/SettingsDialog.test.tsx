import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Platform } from '../../platform/types';
import { preferencesKey, usePreferences } from '../../store/preferences';
import { SettingsDialog } from './SettingsDialog';

const platform = { kind: 'browser' } as Platform;

beforeEach(() => {
  localStorage.clear();
  usePreferences.getState().load('user-1');
});

describe('SettingsDialog 개인정보·보안', () => {
  it('기본값은 가림 끔, 자동 잠금 끔이다', () => {
    render(<SettingsDialog platform={platform} onClose={() => undefined} />);
    expect(screen.getByRole('checkbox', { name: /전화번호 가려서 표시/ })).not.toBeChecked();
    expect(screen.getByLabelText('자동 잠금 시간')).toHaveValue('0');
  });

  it('글자 크기·시작 화면·알림 설정을 바꾸면 저장된다', () => {
    render(<SettingsDialog platform={platform} onClose={() => undefined} />);
    expect(screen.getByRole('checkbox', { name: /알림 센터/ })).toBeChecked();
    fireEvent.change(screen.getByLabelText('글자 크기'), { target: { value: '1.1' } });
    fireEvent.change(screen.getByLabelText('시작 화면'), { target: { value: 'appointments' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /알림 센터/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /새 버전 알림/ }));
    expect(JSON.parse(localStorage.getItem(preferencesKey('user-1'))!)).toMatchObject({ fontScale: 1.1, startMenu: 'appointments', notificationsEnabled: false, updateNotice: false });
  });

  it('옵션을 바꾸면 사용자별로 저장된다', () => {
    render(<SettingsDialog platform={platform} onClose={() => undefined} />);
    fireEvent.click(screen.getByRole('checkbox', { name: /전화번호 가려서 표시/ }));
    fireEvent.change(screen.getByLabelText('자동 잠금 시간'), { target: { value: '10' } });
    expect(JSON.parse(localStorage.getItem(preferencesKey('user-1'))!)).toMatchObject({ maskPhone: true, idleLockMinutes: 10 });
    expect(Array.from(screen.getByLabelText('자동 잠금 시간').querySelectorAll('option')).map((option) => option.textContent)).toEqual(['끔', '5분', '10분', '30분']);
  });
});
