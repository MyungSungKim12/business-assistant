import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfirmDialog } from '@business-assistant/react-ui';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserPlatform } from '../../platform/browser';
import type { Platform, UpdateCheckResult, UpdateProgress } from '../../platform/types';
import { UpdateSection } from './UpdateSection';

function platformWith(extra: Partial<Platform>): Platform {
  return { ...createBrowserPlatform(), kind: 'tauri', ...extra };
}
function view(platform: Platform) {
  return render(<><UpdateSection platform={platform} /><ConfirmDialog /></>);
}

describe('UpdateSection', () => {
  it('keeps the unsupported notice in the browser preview', () => {
    view(createBrowserPlatform());
    expect(screen.getByText('패키징 단계에서 지원 예정')).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('explains when the update server is not configured', async () => {
    const checkUpdate = vi.fn(async (): Promise<UpdateCheckResult> => ({ configured: false, currentVersion: '0.1.0', reason: 'endpoint' }));
    view(platformWith({ checkUpdate }));
    fireEvent.click(screen.getByRole('button', { name: '업데이트 확인' }));
    expect(await screen.findByText('업데이트 서버가 설정되지 않았습니다(관리자 설정 필요).')).toBeInTheDocument();
    expect(screen.getByText(/현재 0\.1\.0/)).toBeInTheDocument();
  });

  it('reports the latest version', async () => {
    view(platformWith({ checkUpdate: async () => ({ configured: true, currentVersion: '0.1.0', available: false }) }));
    fireEvent.click(screen.getByRole('button', { name: '업데이트 확인' }));
    expect(await screen.findByText('최신 버전입니다.')).toBeInTheDocument();
  });

  it('shows a Korean error when the check fails', async () => {
    view(platformWith({ checkUpdate: async () => { throw new Error('연결 실패'); } }));
    fireEvent.click(screen.getByRole('button', { name: '업데이트 확인' }));
    expect(await screen.findByText('업데이트 중 오류가 발생했습니다: 연결 실패')).toBeInTheDocument();
  });

  it('loads and persists the native automatic update check preference', async () => {
    const getAutoUpdateCheckEnabled = vi.fn(async () => false);
    const setAutoUpdateCheckEnabled = vi.fn(async (_enabled: boolean) => undefined);
    view(platformWith({ getAutoUpdateCheckEnabled, setAutoUpdateCheckEnabled }));

    const toggle = await screen.findByRole('checkbox', { name: /자동 업데이트 확인/ });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(setAutoUpdateCheckEnabled).toHaveBeenCalledWith(true));
    expect(await screen.findByText('자동 업데이트 확인 설정을 저장했습니다.')).toBeInTheDocument();
  });

  it('confirms before installing and shows progress', async () => {
    let emit: (p: UpdateProgress) => void = () => undefined;
    const installUpdate = vi.fn(() => new Promise<void>(() => undefined));
    view(platformWith({
      checkUpdate: async () => ({ configured: true, currentVersion: '0.1.0', available: true, version: '0.2.0', notes: '고객 목록 개선' }),
      installUpdate,
      onUpdateProgress: async (handler) => { emit = handler; return () => undefined; },
    }));
    fireEvent.click(screen.getByRole('button', { name: '업데이트 확인' }));
    expect(await screen.findByText('고객 목록 개선')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '지금 설치' }));
    expect(await screen.findByText(/앱이 재시작됩니다. 작성 중인 내용은 먼저 저장/)).toBeInTheDocument();
    expect(installUpdate).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: '지금 설치' }).at(-1)!);
    await waitFor(() => expect(installUpdate).toHaveBeenCalledOnce());
    act(() => emit({ downloaded: 50, total: 200 }));
    expect(await screen.findByText(/다운로드 25%/)).toBeInTheDocument();
  });

  it('does not install when the confirmation is cancelled', async () => {
    const installUpdate = vi.fn(async () => undefined);
    view(platformWith({ checkUpdate: async () => ({ configured: true, currentVersion: '0.1.0', available: true, version: '0.2.0' }), installUpdate }));
    fireEvent.click(screen.getByRole('button', { name: '업데이트 확인' }));
    fireEvent.click(await screen.findByRole('button', { name: '지금 설치' }));
    fireEvent.click(await screen.findByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '취소' })).toBeNull());
    expect(installUpdate).not.toHaveBeenCalled();
  });
});
