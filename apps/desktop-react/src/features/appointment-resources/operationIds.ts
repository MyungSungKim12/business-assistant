import { useRef } from 'react';

/**
 * 같은 내용의 재시도가 같은 operation_id를 쓰게 해 서버 멱등 처리로 이중 저장을 막는다.
 * 입력(fingerprint)이 바뀌면 새 ID를 만들고, 성공하거나 서버가 명확히 거절한 뒤에는 reset()으로 비운다.
 * 결과를 알 수 없는 실패(네트워크 오류·5xx)에서는 비우지 않아야 다음 시도가 같은 ID를 쓴다.
 */
export function createOperationTracker(makeId: () => string = () => crypto.randomUUID()) {
  let current: { key: string; id: string } | null = null;
  return {
    idFor(key: string): string {
      if (!current || current.key !== key) current = { key, id: makeId() };
      return current.id;
    },
    reset(): void { current = null; },
  };
}
export type OperationTracker = ReturnType<typeof createOperationTracker>;

export function useOperationTracker(): OperationTracker {
  const ref = useRef<OperationTracker | null>(null);
  if (!ref.current) ref.current = createOperationTracker();
  return ref.current;
}

/** 서버가 요청을 명확히 거절했는지(같은 ID로 재시도해도 결과가 같다). 4xx(408·429 제외)는 거절로 본다. */
export function isDefiniteRejection(error: unknown): boolean {
  const status = (error as { status?: number } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}
