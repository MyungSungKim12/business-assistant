import { describe, expect, it } from 'vitest';
import { blockBox, computeGridRange, placeBlocks, type BlockInput } from './layoutBlocks';

const block = (id: string, startMin: number, endMin: number, buffer = 0): BlockInput => ({ id, startMin, endMin, bufferEndMin: endMin + buffer });
const byId = (blocks: ReturnType<typeof placeBlocks>) => Object.fromEntries(blocks.map((item) => [item.id, item]));

describe('placeBlocks', () => {
  it('겹치지 않는 예약은 한 칸을 다 쓴다', () => {
    const placed = byId(placeBlocks([block('a', 540, 600), block('b', 660, 720)]));
    expect(placed.a).toMatchObject({ lane: 0, laneCount: 1 });
    expect(placed.b).toMatchObject({ lane: 0, laneCount: 1 });
  });

  it('맞닿기만 한 예약은 겹침이 아니다', () => {
    const placed = byId(placeBlocks([block('a', 540, 600), block('b', 600, 660)]));
    expect(placed.a.laneCount).toBe(1);
    expect(placed.b.laneCount).toBe(1);
  });

  it('겹치는 예약은 옆으로 나눈다', () => {
    const placed = byId(placeBlocks([block('a', 540, 630), block('b', 600, 660)]));
    expect(placed.a).toMatchObject({ lane: 0, laneCount: 2 });
    expect(placed.b).toMatchObject({ lane: 1, laneCount: 2 });
  });

  it('여유 시간까지 겹치면 같은 묶음이다', () => {
    const placed = byId(placeBlocks([block('a', 540, 600, 15), block('b', 605, 660)]));
    expect(placed.a.laneCount).toBe(2);
    expect(placed.b.lane).toBe(1);
  });

  it('끝난 칸은 재사용하고 묶음마다 칸 수를 따로 센다', () => {
    const placed = byId(placeBlocks([
      block('a', 540, 720),
      block('b', 560, 600),
      block('c', 610, 650), // b가 끝난 칸 재사용
      block('d', 900, 960), // 다른 묶음
    ]));
    expect(placed.a).toMatchObject({ lane: 0, laneCount: 2 });
    expect(placed.b).toMatchObject({ lane: 1, laneCount: 2 });
    expect(placed.c).toMatchObject({ lane: 1, laneCount: 2 });
    expect(placed.d).toMatchObject({ lane: 0, laneCount: 1 });
  });

  it('입력 순서와 상관없이 같은 배치를 만든다', () => {
    const forward = placeBlocks([block('a', 540, 630), block('b', 600, 660), block('c', 620, 700)]);
    const reverse = placeBlocks([block('c', 620, 700), block('b', 600, 660), block('a', 540, 630)]);
    expect(byId(forward)).toEqual(byId(reverse));
    expect(byId(forward).c.lane).toBe(2);
  });

  it('자정 근처(0시·24시)의 예약도 배치한다', () => {
    const placed = byId(placeBlocks([block('late', 1410, 1440), block('early', 0, 30), block('late2', 1425, 1440)]));
    expect(placed.early).toMatchObject({ lane: 0, laneCount: 1 });
    expect(placed.late.laneCount).toBe(2);
    expect(placed.late2.lane).toBe(1);
  });

  it('길이가 0인 예약도 최소 15분을 차지한다', () => {
    const placed = byId(placeBlocks([block('a', 600, 600), block('b', 605, 650)]));
    expect(placed.a.laneCount).toBe(2);
  });
});

describe('computeGridRange', () => {
  it('기본은 08:00~22:00', () => {
    expect(computeGridRange([])).toEqual({ startMin: 480, endMin: 1320 });
    expect(computeGridRange([block('a', 600, 660)])).toEqual({ startMin: 480, endMin: 1320 });
  });

  it('범위 밖 예약이 있으면 정각 단위로 넓힌다', () => {
    expect(computeGridRange([block('early', 0, 30)])).toEqual({ startMin: 0, endMin: 1320 });
    expect(computeGridRange([block('late', 1410, 1440)])).toEqual({ startMin: 480, endMin: 1440 });
    expect(computeGridRange([block('x', 440, 500), block('y', 1300, 1335, 10)])).toEqual({ startMin: 420, endMin: 1380 });
  });
});

describe('blockBox', () => {
  const range = { startMin: 480, endMin: 1320 };
  const perMinute = 28 / 30;

  it('시작·소요·여유를 분에 비례한 위치·높이로 바꾼다', () => {
    const [placed] = placeBlocks([block('a', 600, 660, 10)]);
    const box = blockBox(placed, range, perMinute);
    expect(box.top).toBeCloseTo(120 * perMinute);
    expect(box.height).toBeCloseTo(70 * perMinute);
    expect(box.bufferHeight).toBeCloseTo(10 * perMinute);
    expect(box).toMatchObject({ left: 0, width: 100 });
  });

  it('칸 수만큼 가로를 나눈다', () => {
    const placed = byId(placeBlocks([block('a', 600, 660), block('b', 620, 680), block('c', 630, 690)]));
    expect(blockBox(placed.b, range, perMinute)).toMatchObject({ left: 100 / 3, width: 100 / 3 });
  });

  it('너무 짧은 블록은 최소 높이를 갖는다', () => {
    const [placed] = placeBlocks([block('a', 600, 605, 5)]);
    expect(blockBox(placed, range, perMinute, 18).height).toBe(18);
  });

  it('눈금 범위를 벗어나는 부분은 자른다', () => {
    const [placed] = placeBlocks([block('a', 1300, 1380)]);
    const box = blockBox(placed, range, perMinute);
    expect(box.top).toBeCloseTo(820 * perMinute);
    expect(box.height).toBeCloseTo(20 * perMinute);
  });
});
