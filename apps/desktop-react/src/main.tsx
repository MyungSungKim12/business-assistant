import { invoke } from '@tauri-apps/api/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { ApiClient } from './api/client';
import { App } from './app/App';
import { ErrorBoundary } from './app/ErrorBoundary';
import { createBrowserPlatform } from './platform/browser';
import { createTauriPlatform } from './platform/tauri';
import type { Platform } from './platform/types';

const root = document.getElementById('root');

if (!root) {
  throw new Error('React root element was not found.');
}

// 화면이 비어 보이는 오류도 로그 파일에 남긴다(데스크톱 전용).
function installErrorLogging() {
  if (!('__TAURI_INTERNALS__' in window)) return;
  const send = (message: string, level = 'ERROR') => { void invoke('log_write', { level, message }).catch(() => undefined); };
  window.addEventListener('error', (event) => send(`스크립트 오류: ${event.message} (${event.filename}:${event.lineno})`));
  window.addEventListener('unhandledrejection', (event) => send(`처리되지 않은 거부: ${event.reason instanceof Error ? event.reason.message : String(event.reason)}`));
  send('프런트엔드 시작', 'INFO');
}
installErrorLogging();

/** 화면 렌더링 오류를 로그 한 줄로 만든다. 컴포넌트 스택은 앞 3줄만 남긴다(전화번호는 Rust 로그 쪽에서 가린다). */
function describeRenderError(error: Error, componentStack: string): string {
  const stack = componentStack.trim().split('\n').slice(0, 3).map((line) => line.trim()).join(' <- ');
  return `화면 오류: ${error.name}: ${error.message.slice(0, 300)}${stack ? ` | ${stack}` : ''}`;
}

function showFatal(reason: unknown, platform?: Platform) {
  const message = reason instanceof Error ? reason.message : String(reason);
  platform?.log?.('ERROR', `시작 실패: ${message}`);
  const box = document.createElement('pre');
  box.className = 'fatal';
  box.textContent = [
    `시작하지 못했습니다: ${message}`,
    '',
    'API 주소(BUSINESS_ASSISTANT_API_BASE)와 API 서버 실행 여부를 확인하세요.',
    '자세한 내용은 로그 파일(%LOCALAPPDATA%\com.businessassistant.desktop\logs)에 있습니다.',
  ].join('\n');
  root!.replaceChildren(box);
}

async function boot() {
  let platform: Platform | undefined;
  try {
    platform = '__TAURI_INTERNALS__' in window ? await createTauriPlatform() : createBrowserPlatform();
    const services = { platform, api: new ApiClient(platform) };
    createRoot(root!).render(
      <StrictMode>
        <ErrorBoundary scope="app" onError={(error, stack) => platform?.log?.('ERROR', describeRenderError(error, stack))}>
          <App services={services} />
        </ErrorBoundary>
      </StrictMode>,
    );
  } catch (reason) {
    showFatal(reason, platform);
  }
  // 첫 화면(또는 오류 안내)을 렌더링한 뒤 창을 연다. 숨겨진 창에서는 requestAnimationFrame이 멈추므로 타이머를 쓴다.
  setTimeout(() => { void platform?.notifyReady?.().catch(() => undefined); }, 50);
}

void boot();
