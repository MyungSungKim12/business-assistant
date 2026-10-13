import { useEffect, useRef, useState } from 'react';
import { confirm } from '@business-assistant/react-ui';
import type { Platform, UpdateProgress } from '../../platform/types';

type Phase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'latest' }
  | { kind: 'unconfigured'; reason?: 'endpoint' | 'pubkey' }
  | { kind: 'available'; version: string; notes?: string }
  | { kind: 'installing'; progress: UpdateProgress | null }
  | { kind: 'error'; message: string };

function describe(phase: Phase, supported: boolean): string {
  if (!supported) return '패키징 단계에서 지원 예정';
  switch (phase.kind) {
    case 'idle': return '새 버전을 확인할 수 있습니다.';
    case 'checking': return '업데이트를 확인하는 중입니다…';
    case 'latest': return '최신 버전입니다.';
    case 'unconfigured':
      return phase.reason === 'pubkey'
        ? '업데이트 서명 키가 설정되지 않았습니다(관리자 설정 필요).'
        : '업데이트 서버가 설정되지 않았습니다(관리자 설정 필요).';
    case 'available': return `새 버전 ${phase.version}을(를) 설치할 수 있습니다.`;
    case 'installing': {
      const p = phase.progress;
      if (!p || !p.total) return '다운로드하는 중입니다…';
      return `다운로드 ${Math.min(100, Math.floor((p.downloaded / p.total) * 100))}% — 완료되면 앱이 재시작됩니다.`;
    }
    case 'error': return phase.message;
  }
}

function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return raw ? `업데이트 중 오류가 발생했습니다: ${raw}` : '업데이트 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.';
}

export function UpdateSection({ platform }: { platform: Platform }) {
  const supported = Boolean(platform.checkUpdate);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [version, setVersion] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { platform.appVersion?.().then((v) => { if (alive.current && v) setVersion(v); }).catch(() => undefined); }, [platform]);
  const update = (next: Phase) => { if (alive.current) setPhase(next); };

  const check = async () => {
    if (!platform.checkUpdate) return;
    update({ kind: 'checking' });
    try {
      const result = await platform.checkUpdate();
      if (alive.current) setVersion(result.currentVersion || version);
      if (!result.configured) update({ kind: 'unconfigured', reason: result.reason });
      else if (result.available) update({ kind: 'available', version: result.version, notes: result.notes });
      else update({ kind: 'latest' });
    } catch (error) { update({ kind: 'error', message: errorMessage(error) }); }
  };

  const install = async () => {
    if (!platform.installUpdate || phase.kind !== 'available') return;
    const ok = await confirm({
      title: '업데이트 설치',
      message: `새 버전 ${phase.version}을(를) 설치합니다. 설치 후 앱이 재시작됩니다. 작성 중인 내용은 먼저 저장해 주세요.`,
      confirmLabel: '지금 설치',
    });
    if (!ok) return;
    update({ kind: 'installing', progress: null });
    let off: (() => void) | undefined;
    try {
      off = await platform.onUpdateProgress?.((progress) => update({ kind: 'installing', progress }));
      await platform.installUpdate();
    } catch (error) { update({ kind: 'error', message: errorMessage(error) }); }
    finally { off?.(); }
  };

  const busy = phase.kind === 'checking' || phase.kind === 'installing';
  return (
    <div>
      <span>
        <strong>업데이트 확인{version ? ` (현재 ${version})` : ''}</strong>
        <small role="status">{describe(phase, supported)}</small>
        {phase.kind === 'available' && phase.notes ? <small>{phase.notes}</small> : null}
      </span>
      {supported ? (
        phase.kind === 'available'
          ? <button type="button" className="ba-primary" onClick={() => void install()}>지금 설치</button>
          : <button type="button" disabled={busy} onClick={() => void check()}>{phase.kind === 'checking' ? '확인 중…' : '업데이트 확인'}</button>
      ) : null}
    </div>
  );
}
