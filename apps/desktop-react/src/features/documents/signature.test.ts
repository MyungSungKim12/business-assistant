import { describe, expect, it } from 'vitest';
import { appendPoint, hasInk, MAX_POINTS_PER_STROKE, MAX_STROKES, MAX_TOTAL_POINTS, normalizePoint, startStroke, totalPoints, undoStroke, type Strokes } from './signature';

describe('손서명 벡터 로직', () => {
  it('좌표를 0~1 범위와 소수 6자리로 정규화한다', () => {
    expect(normalizePoint(50, 25, 200, 100)).toEqual([0.25, 0.25]);
    expect(normalizePoint(-10, 500, 200, 100)).toEqual([0, 1]);
    expect(normalizePoint(1, 1, 3, 3)).toEqual([0.333333, 0.333333]);
    expect(normalizePoint(10, 10, 0, 0)).toEqual([1, 1]);
    expect(normalizePoint(Number.NaN, 5, 10, 10)).toEqual([0, 0.5]);
  });

  it('획을 시작하고 점을 더하며 같은 점은 무시한다', () => {
    let strokes: Strokes = startStroke([], [0.1, 0.1]);
    strokes = appendPoint(strokes, [0.2, 0.2]);
    expect(appendPoint(strokes, [0.2, 0.2])).toBe(strokes);
    expect(strokes).toEqual([[[0.1, 0.1], [0.2, 0.2]]]);
    expect(appendPoint([], [0, 0])).toEqual([]);
  });

  it('서버 한도(50획·획당 500점·총 5000점)를 넘지 않는다', () => {
    let strokes: Strokes = [];
    for (let index = 0; index < MAX_STROKES + 5; index += 1) strokes = startStroke(strokes, [index / 100, 0]);
    expect(strokes).toHaveLength(MAX_STROKES);
    let line: Strokes = startStroke([], [0, 0]);
    for (let index = 1; index < MAX_POINTS_PER_STROKE + 20; index += 1) line = appendPoint(line, [index / 1000, 0.5]);
    expect(line[0]).toHaveLength(MAX_POINTS_PER_STROKE);
    let many: Strokes = [];
    for (let stroke = 0; stroke < 11; stroke += 1) {
      many = startStroke(many, [stroke / 20, 0]);
      for (let index = 1; index < MAX_POINTS_PER_STROKE; index += 1) many = appendPoint(many, [stroke / 20, index / 1000]);
    }
    expect(totalPoints(many)).toBeLessThanOrEqual(MAX_TOTAL_POINTS);
  });

  it('되돌리기는 마지막 획만 지운다', () => {
    const strokes: Strokes = [[[0, 0], [1, 1]], [[0.5, 0.5]]];
    expect(undoStroke(strokes)).toEqual([[[0, 0], [1, 1]]]);
    expect(undoStroke([])).toEqual([]);
  });

  it('서로 다른 점이 둘 이상일 때만 서명으로 인정한다', () => {
    expect(hasInk([])).toBe(false);
    expect(hasInk([[[0.3, 0.3]]])).toBe(false);
    expect(hasInk([[[0.3, 0.3], [0.3, 0.3]]])).toBe(false);
    expect(hasInk([[[0.3, 0.3]], [[0.4, 0.3]]])).toBe(true);
  });
});
