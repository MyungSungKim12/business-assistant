import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** 이 값이 바뀌면(예: 다른 메뉴로 이동) 오류 상태를 풀고 다시 그린다. */
  resetKey?: string;
  /** 'page'는 작업 영역 안에만 오류를 보여 주고, 'app'은 화면 전체를 대신한다. */
  scope?: 'page' | 'app';
  /** 오류를 로그 파일 등에 남긴다. 개인정보가 담길 수 있는 원문 데이터는 넘기지 않는다. */
  onError?: (error: Error, componentStack: string) => void;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/** 렌더링 중 예외가 나도 앱 전체가 흰 화면이 되지 않게 하고, 다시 시도·진단 정보 복사를 제공한다. */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    this.props.onError?.(error, info.componentStack ?? '');
  }

  componentDidUpdate(previous: ErrorBoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private reset = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return <ErrorFallback error={error} scope={this.props.scope ?? 'page'} onRetry={this.reset} />;
  }
}

/** 숫자가 9자리 이상 이어지는 구간(전화번호 등)은 가린다. */
const maskDigits = (text: string) => text.replace(/\d[\d-]{7,}\d/g, '***');

/** 진단 정보: 시각, 화면 크기, 오류 종류와 메시지 앞부분만 담고 전화번호 같은 숫자열은 가린다. */
export function diagnosticText(error: Error, now: Date = new Date()): string {
  const message = maskDigits(error.message.replace(/\s+/g, ' ')).slice(0, 300);
  return [
    `시각: ${now.toISOString()}`,
    `화면: ${window.innerWidth}x${window.innerHeight}`,
    `오류: ${error.name}: ${message}`,
    '로그 위치: %LOCALAPPDATA%\com.businessassistant.desktop\logs',
  ].join('\n');
}

function ErrorFallback({ error, scope, onRetry }: { error: Error; scope: 'page' | 'app'; onRetry: () => void }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(diagnosticText(error)); } catch { /* 클립보드를 쓸 수 없으면 조용히 넘어간다 */ }
  };
  return (
    <section className={`error-fallback error-fallback--${scope}`} role="alert">
      <h1>화면을 표시하는 중 문제가 발생했습니다</h1>
      <p className="muted">작성 중이던 내용은 저장되지 않았을 수 있습니다. 다시 시도해도 같으면 진단 정보를 복사해 관리자에게 전달해 주세요.</p>
      <div className="row-actions">
        <button type="button" className="primary-button" onClick={onRetry}>다시 시도</button>
        {scope === 'app' && <button type="button" onClick={() => window.location.reload()}>앱 새로 고침</button>}
        <button type="button" onClick={() => void copy()}>진단 정보 복사</button>
      </div>
      <pre className="error-fallback__detail">{diagnosticText(error)}</pre>
    </section>
  );
}
