import { useCallback, useRef } from 'react';

/**
 * 항상 최신 클로저를 호출하지만 식별자는 바뀌지 않는 콜백.
 * Modal은 onClose가 바뀔 때마다 포커스를 첫 요소로 되돌리므로, 입력 중 리렌더로 포커스가 튀지 않게 한다.
 */
export function useStable<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
  const ref = useRef(callback);
  ref.current = callback;
  return useCallback((...args: A) => ref.current(...args), []);
}
