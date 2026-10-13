import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignaturePad } from './SignaturePad';
import type { Strokes } from './signature';

const context = { setTransform: vi.fn(), clearRect: vi.fn(), fillRect: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(), arc: vi.fn(), fill: vi.fn() };

function Harness({ onChange, disabled = false }: { onChange: (strokes: Strokes) => void; disabled?: boolean }) {
  const [value, setValue] = useState<Strokes>([]);
  return <SignaturePad value={value} disabled={disabled} onChange={(next) => { setValue(next); onChange(next); }} />;
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context as never);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120, x: 10, y: 20, toJSON: () => ({}) });
});

const pointer = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number, y: number, extra: Record<string, unknown> = {}) =>
  fireEvent[type](screen.getByLabelText('고객 손서명 입력'), { clientX: x, clientY: y, pointerId: 1, pointerType: 'pen', button: 0, ...extra });

describe('SignaturePad', () => {
  it('포인터(펜·터치·마우스)로 획을 그리고 정규화한 좌표를 돌려준다', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    pointer('pointerDown', 10, 20);
    pointer('pointerMove', 110, 70);
    pointer('pointerUp', 210, 120);
    expect(onChange).toHaveBeenLastCalledWith([[[0, 0], [0.5, 0.5], [1, 1]]]);
    pointer('pointerDown', 60, 70, { pointerType: 'touch', pointerId: 2 });
    expect(onChange).toHaveBeenLastCalledWith([[[0, 0], [0.5, 0.5], [1, 1]], [[0.25, 0.5]]]);
  });

  it('마우스 오른쪽 버튼과 눌리지 않은 이동은 무시한다', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    pointer('pointerDown', 50, 50, { pointerType: 'mouse', button: 2 });
    pointer('pointerMove', 80, 80);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('되돌리기는 마지막 획을, 지우기는 모든 획을 없앤다', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    expect(screen.getByRole('button', { name: '되돌리기' })).toBeDisabled();
    pointer('pointerDown', 10, 20);
    pointer('pointerMove', 60, 70);
    pointer('pointerUp', 60, 70);
    pointer('pointerDown', 110, 70, { pointerId: 3 });
    pointer('pointerUp', 110, 70, { pointerId: 3 });
    fireEvent.click(screen.getByRole('button', { name: '되돌리기' }));
    expect(onChange).toHaveBeenLastCalledWith([[[0, 0], [0.25, 0.5]]]);
    fireEvent.click(screen.getByRole('button', { name: '서명 지우기' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('비활성화되면 입력과 버튼이 모두 막힌다', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} disabled />);
    pointer('pointerDown', 10, 20);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: '서명 지우기' })).toBeDisabled();
  });
});
