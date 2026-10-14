/** 30분 칸의 높이(px). 시간축 높이는 이 값에 비례한다. */
export const SLOT_MINUTES = 30;
export const SLOT_HEIGHT = 28;

/**
 * 드롭한 세로 위치(열 맨 위 기준 px)와 잡은 위치(블록 맨 위 기준 px)로 새 시작 시각(분)을 구한다.
 * 블록 위쪽 끝이 놓인 30분 칸에 맞추고, 하루(0~1439분)를 벗어나면 null.
 */
export function dropStartMinutes(rangeStartMin: number, dropY: number, grabOffsetY: number): number | null {
  const topY = (Number.isFinite(dropY) ? dropY : 0) - Math.max(0, Number.isFinite(grabOffsetY) ? grabOffsetY : 0);
  const slot = Math.max(0, Math.floor(topY / SLOT_HEIGHT));
  const minutes = rangeStartMin + slot * SLOT_MINUTES;
  return minutes >= 0 && minutes < 24 * 60 ? minutes : null;
}
