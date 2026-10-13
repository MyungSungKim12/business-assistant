import { useCallback, useEffect, useRef, type PointerEvent } from 'react';
import { appendPoint, drawStrokes, normalizePoint, startStroke, undoStroke, type Strokes } from './signature';

export interface SignaturePadProps {
  value: Strokes;
  onChange: (strokes: Strokes) => void;
  disabled?: boolean;
  label?: string;
}

/** 마우스·터치·펜 포인터 입력을 받는 손서명 캔버스. 지우기·되돌리기를 제공한다. */
export function SignaturePad({ value, onChange, disabled = false, label = '고객 손서명 입력' }: SignaturePadProps) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const live = useRef<Strokes>(value);
  const drawing = useRef<number | null>(null);
  live.current = value;

  const paint = useCallback(() => {
    const element = canvas.current;
    if (!element) return;
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight);
    if (element.width !== Math.round(width * ratio)) element.width = Math.round(width * ratio);
    if (element.height !== Math.round(height * ratio)) element.height = Math.round(height * ratio);
    let context: CanvasRenderingContext2D | null = null;
    try { context = element.getContext('2d'); } catch { context = null; }
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawStrokes(context, live.current, width, height);
  }, []);

  useEffect(() => { paint(); }, [paint, value]);
  useEffect(() => {
    const element = canvas.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => paint());
    observer.observe(element);
    return () => observer.disconnect();
  }, [paint]);

  const pointOf = (event: PointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return normalizePoint(event.clientX - rect.left, event.clientY - rect.top, rect.width, rect.height);
  };
  const commit = (next: Strokes) => {
    if (next === live.current) return;
    live.current = next;
    onChange(next);
  };
  const down = (event: PointerEvent<HTMLCanvasElement>) => {
    if (disabled || (event.pointerType === 'mouse' && event.button !== 0) || drawing.current !== null) return;
    const next = startStroke(live.current, pointOf(event));
    if (next === live.current) return;
    drawing.current = event.pointerId;
    try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* 일부 환경은 캡처를 지원하지 않는다 */ }
    commit(next);
  };
  const move = (event: PointerEvent<HTMLCanvasElement>) => {
    if (disabled || drawing.current !== event.pointerId) return;
    commit(appendPoint(live.current, pointOf(event)));
  };
  const up = (event: PointerEvent<HTMLCanvasElement>) => {
    if (drawing.current !== event.pointerId) return;
    commit(appendPoint(live.current, pointOf(event)));
    drawing.current = null;
  };

  return (
    <div className="doc-pad">
      <canvas ref={canvas} className="doc-pad__canvas" aria-label={label} role="img" data-disabled={disabled || undefined}
        onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
      <div className="doc-pad__actions">
        <button type="button" disabled={disabled || value.length === 0} onClick={() => commit(undoStroke(live.current))}>되돌리기</button>
        <button type="button" disabled={disabled || value.length === 0} onClick={() => commit([])}>서명 지우기</button>
      </div>
    </div>
  );
}
