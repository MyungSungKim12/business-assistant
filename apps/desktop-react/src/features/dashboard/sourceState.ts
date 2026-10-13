import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../api/errors';

/** 패널 하나가 데이터를 가져오는 상태. 패널마다 독립적이다. */
export type FailureKind = 'forbidden' | 'unavailable' | 'error';
export interface Failure { kind: FailureKind; message: string }
export type Source<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; failure: Failure };

/** 403은 권한 없음, 404·503은 이 업체에서 쓰지 않는(또는 아직 준비되지 않은) 기능으로 구분한다. */
export function classifyFailure(error: unknown): Failure {
  if (error instanceof ApiError) {
    if (error.status === 403) return { kind: 'forbidden', message: '권한이 없어 볼 수 없습니다. 관리자에게 권한을 요청하세요.' };
    if (error.status === 404 || error.status === 503) return { kind: 'unavailable', message: '이 업체에서 사용하지 않는 기능입니다.' };
  }
  return { kind: 'error', message: '불러오지 못했습니다. 잠시 후 다시 시도하세요.' };
}

export function sourceData<T>(source: Source<T>): T | null {
  return source.status === 'ready' ? source.data : null;
}

/**
 * 로더를 실행해 상태를 돌려준다. deps가 바뀌거나 reload를 부르면 다시 불러온다.
 * 이전 요청의 늦은 응답은 무시한다.
 */
export function useSource<T>(loader: () => Promise<T>, deps: readonly unknown[]): [Source<T>, () => void] {
  const [state, setState] = useState<Source<T>>({ status: 'loading' });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    setState({ status: 'loading' });
    Promise.resolve().then(loader).then(
      (data) => { if (live) setState({ status: 'ready', data }); },
      (error: unknown) => { if (live) setState({ status: 'error', failure: classifyFailure(error) }); },
    );
    return () => { live = false; };
    // loader는 deps가 바뀔 때마다 새로 만들어진다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return [state, reload];
}
