import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';

type DraftState = { dirty: boolean; busy: boolean };
type Register = (key: symbol, state: DraftState | null) => void;
const DraftContext = createContext<Register | null>(null);

/** 여러 편집기의 상태를 합산하여 다른 폼의 보호를 지우지 않는다. */
export function DraftBoundary({ children, onDirtyChange, onBusyChange, externalDirty = false }: {
  children: ReactNode; onDirtyChange: (dirty: boolean) => void;
  onBusyChange?: (busy: boolean) => void; externalDirty?: boolean;
}) {
  const states = useRef(new Map<symbol, DraftState>());
  const latest = useRef({ onDirtyChange, onBusyChange, externalDirty });
  latest.current = { onDirtyChange, onBusyChange, externalDirty };
  const register = useRef<Register>((key, state) => {
    if (state) states.current.set(key, state); else states.current.delete(key);
    latest.current.onDirtyChange(latest.current.externalDirty || [...states.current.values()].some(x => x.dirty || x.busy));
    latest.current.onBusyChange?.([...states.current.values()].some(x => x.busy));
  }).current;
  useEffect(() => { register(Symbol.for('legacy'), { dirty: externalDirty, busy: false }); }, [externalDirty, register]);
  useEffect(() => () => { latest.current.onDirtyChange(false); latest.current.onBusyChange?.(false); }, []);
  return <DraftContext.Provider value={register}>{children}</DraftContext.Provider>;
}

export function useDraftProtection(dirty: boolean, busy = false) {
  const register = useContext(DraftContext);
  const key = useRef(Symbol('editor')).current;
  useEffect(() => { register?.(key, { dirty, busy }); }, [register, key, dirty, busy]);
  useEffect(() => () => register?.(key, null), [register, key]);
}
