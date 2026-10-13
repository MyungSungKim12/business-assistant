/** 손서명 벡터 모델. 좌표는 0~1로 정규화해 화면 크기가 바뀌어도 증빙이 변하지 않는다(서버 한도와 동일). */
export type Point = [number, number];
export type Stroke = Point[];
export type Strokes = Stroke[];

export const MAX_STROKES = 50;
export const MAX_POINTS_PER_STROKE = 500;
export const MAX_TOTAL_POINTS = 5000;

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const round6 = (value: number) => Math.round(value * 1e6) / 1e6;

/** 화면 좌표를 0~1 범위, 소수 6자리로 정규화한다. */
export function normalizePoint(x: number, y: number, width: number, height: number): Point {
  return [round6(clamp01(x / Math.max(1, width))), round6(clamp01(y / Math.max(1, height)))];
}

export const totalPoints = (strokes: Strokes): number => strokes.reduce((sum, stroke) => sum + stroke.length, 0);

/** 새 획을 시작한다. 한도를 넘으면 그대로 돌려준다. */
export function startStroke(strokes: Strokes, point: Point): Strokes {
  if (strokes.length >= MAX_STROKES || totalPoints(strokes) >= MAX_TOTAL_POINTS) return strokes;
  return [...strokes, [point]];
}

/** 마지막 획에 점을 더한다. 같은 점이거나 한도를 넘으면 무시한다. */
export function appendPoint(strokes: Strokes, point: Point): Strokes {
  const last = strokes[strokes.length - 1];
  if (!last || last.length >= MAX_POINTS_PER_STROKE || totalPoints(strokes) >= MAX_TOTAL_POINTS) return strokes;
  const previous = last[last.length - 1];
  if (previous[0] === point[0] && previous[1] === point[1]) return strokes;
  return [...strokes.slice(0, -1), [...last, point]];
}

/** 마지막 획을 되돌린다. */
export const undoStroke = (strokes: Strokes): Strokes => strokes.slice(0, -1);

/** 서버 규칙: 서로 다른 점이 둘 이상이어야 서명으로 인정한다. */
export function hasInk(strokes: Strokes): boolean {
  return new Set(strokes.flat().map(([x, y]) => `${x},${y}`)).size >= 2;
}

export function drawStrokes(context: CanvasRenderingContext2D, strokes: Strokes, width: number, height: number): void {
  context.clearRect(0, 0, width, height);
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.strokeStyle = '#111';
  context.fillStyle = '#111';
  context.lineWidth = 2.2;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  for (const stroke of strokes) {
    if (stroke.length === 1) {
      context.beginPath();
      context.arc(stroke[0][0] * width, stroke[0][1] * height, 1.2, 0, Math.PI * 2);
      context.fill();
      continue;
    }
    context.beginPath();
    stroke.forEach(([x, y], index) => (index === 0 ? context.moveTo(x * width, y * height) : context.lineTo(x * width, y * height)));
    context.stroke();
  }
}
