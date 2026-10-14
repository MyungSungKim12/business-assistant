import { describe, expect, it } from 'vitest';
import { SLOT_HEIGHT, SLOT_MINUTES, dropStartMinutes } from './dragMove';

describe('dropStartMinutes', () => {
  it('블록 위쪽 끝이 놓인 30분 칸의 시작 시각을 돌려준다', () => {
    expect(dropStartMinutes(540, 0, 0)).toBe(540);
    expect(dropStartMinutes(540, SLOT_HEIGHT * 3 + 5, 0)).toBe(540 + 3 * SLOT_MINUTES);
  });
  it('블록의 중간을 잡고 끌었으면 잡은 높이만큼 위로 보정한다', () => {
    expect(dropStartMinutes(540, SLOT_HEIGHT * 4 + 3, SLOT_HEIGHT * 2 + 1)).toBe(540 + 2 * SLOT_MINUTES);
  });
  it('격자 위로 벗어나면 첫 칸에 맞추고, 하루를 넘으면 null이다', () => {
    expect(dropStartMinutes(540, -50, 0)).toBe(540);
    expect(dropStartMinutes(540, SLOT_HEIGHT * 40, 0)).toBeNull();
  });
});
