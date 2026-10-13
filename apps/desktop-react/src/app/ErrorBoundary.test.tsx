import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary, diagnosticText } from './ErrorBoundary';

function Bomb({ explode }: { explode: boolean }) {
  if (explode) throw new Error('화면 계산 오류 박지민 010-1234-5678');
  return <p>정상 화면</p>;
}

describe('ErrorBoundary', () => {
  beforeEach(() => { vi.spyOn(console, 'error').mockImplementation(() => undefined); });
  afterEach(() => vi.restoreAllMocks());

  it('shows a recoverable fallback instead of a blank screen and reports the error', () => {
    const onError = vi.fn();
    render(<ErrorBoundary onError={onError}><Bomb explode /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toHaveTextContent('화면을 표시하는 중 문제가 발생했습니다');
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(screen.getByRole('button', { name: '진단 정보 복사' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '앱 새로 고침' })).not.toBeInTheDocument();
  });

  it('offers a full-app reload only for the app scope', () => {
    render(<ErrorBoundary scope="app"><Bomb explode /></ErrorBoundary>);
    expect(screen.getByRole('button', { name: '앱 새로 고침' })).toBeInTheDocument();
  });

  it('recovers when the user retries after the cause is gone', () => {
    function Harness() {
      const [explode, setExplode] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setExplode(false)}>원인 해결</button>
          <ErrorBoundary><Bomb explode={explode} /></ErrorBoundary>
        </>
      );
    }
    render(<Harness />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '원인 해결' }));
    fireEvent.click(screen.getByRole('button', { name: '다시 시도' }));
    expect(screen.getByText('정상 화면')).toBeInTheDocument();
  });

  it('clears the error when the reset key changes (navigating to another menu)', () => {
    const view = render(<ErrorBoundary resetKey="customers"><Bomb explode /></ErrorBoundary>);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    view.rerender(<ErrorBoundary resetKey="tasks"><Bomb explode={false} /></ErrorBoundary>);
    expect(screen.getByText('정상 화면')).toBeInTheDocument();
  });

  it('masks phone-like numbers in the diagnostic text', () => {
    const text = diagnosticText(new Error('고객 010-1234-5678 처리 실패'));
    expect(text).not.toContain('1234-5678');
    expect(text).toContain('***');
  });

  it('copies a diagnostic summary to the clipboard', () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<ErrorBoundary><Bomb explode /></ErrorBoundary>);
    fireEvent.click(screen.getByRole('button', { name: '진단 정보 복사' }));
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0][0])).toContain('로그 위치');
  });
});

describe('diagnosticText', () => {
  it('summarises the error with the time and log location and truncates long messages', () => {
    const error = new Error('x'.repeat(500));
    const text = diagnosticText(error, new Date('2026-10-13T00:00:00Z'));
    expect(text).toContain('시각: 2026-10-13T00:00:00.000Z');
    expect(text).toContain('Error: ' + 'x'.repeat(300));
    expect(text).not.toContain('x'.repeat(301));
    expect(text).toContain('com.businessassistant.desktop');
  });
});
