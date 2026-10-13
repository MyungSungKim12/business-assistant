/** 달력 열 하나에 그릴 예약 블록의 위치·겹침 계산(순수 함수). 시간 단위는 모두 그날 0시부터의 분이다. */

export interface BlockInput {
  id: string;
  startMin: number;
  /** 서비스 소요가 끝나는 분. */
  endMin: number;
  /** 소요 뒤 여유(정리) 시간이 끝나는 분. endMin 이상. */
  bufferEndMin: number;
}

export interface PlacedBlock extends BlockInput {
  /** 겹치는 묶음 안에서 몇 번째 칸인지(0부터). */
  lane: number;
  /** 그 묶음에서 나란히 놓이는 칸 수. */
  laneCount: number;
}

/** 블록이 차지하는 전체 구간의 끝(여유 포함). 소요가 0분이어도 최소 15분은 차지하는 것으로 본다. */
const occupiedEnd = (block: BlockInput) => Math.max(block.bufferEndMin, block.endMin, block.startMin + 15);

/**
 * 시간이 겹치는 예약끼리 한 묶음으로 보고, 묶음 안에서 가장 앞의 빈 칸에 차례로 배정한다.
 * 맞닿기만 한 예약(앞 예약의 끝 = 뒤 예약의 시작)은 겹치지 않는다.
 */
export function placeBlocks(blocks: BlockInput[]): PlacedBlock[] {
  const sorted = [...blocks].sort((a, b) => a.startMin - b.startMin || occupiedEnd(b) - occupiedEnd(a) || a.id.localeCompare(b.id));
  const placed: PlacedBlock[] = [];
  let cluster: PlacedBlock[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    for (const item of cluster) item.laneCount = laneEnds.length;
    placed.push(...cluster);
    cluster = [];
    laneEnds = [];
    clusterEnd = -Infinity;
  };

  for (const block of sorted) {
    if (cluster.length > 0 && block.startMin >= clusterEnd) flush();
    let lane = laneEnds.findIndex((end) => end <= block.startMin);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = occupiedEnd(block);
    clusterEnd = Math.max(clusterEnd, occupiedEnd(block));
    cluster.push({ ...block, lane, laneCount: 1 });
  }
  flush();
  return placed;
}

export interface GridRange {
  /** 눈금이 시작하는 분(정각). */
  startMin: number;
  /** 눈금이 끝나는 분(정각). */
  endMin: number;
}

export const DEFAULT_GRID_START = 8 * 60;
export const DEFAULT_GRID_END = 22 * 60;

/** 기본 08:00~22:00. 범위 밖 예약이 있으면 정각 단위로 넓혀 보이지 않는 예약이 없게 한다. */
export function computeGridRange(
  blocks: Pick<BlockInput, 'startMin' | 'endMin' | 'bufferEndMin'>[],
  base: GridRange = { startMin: DEFAULT_GRID_START, endMin: DEFAULT_GRID_END },
): GridRange {
  let startMin = base.startMin;
  let endMin = base.endMin;
  for (const block of blocks) {
    startMin = Math.min(startMin, Math.floor(block.startMin / 60) * 60);
    endMin = Math.max(endMin, Math.ceil(Math.max(block.endMin, block.bufferEndMin) / 60) * 60);
  }
  return { startMin: Math.max(0, startMin), endMin: Math.min(1440, endMin) };
}

export interface BlockBox {
  /** 열 안쪽 위에서부터 px. */
  top: number;
  height: number;
  /** 여유 시간 구간의 높이(블록 아래쪽). 0이면 없다. */
  bufferHeight: number;
  /** 0~100 (%). */
  left: number;
  width: number;
}

/** 분 → px 환산으로 블록 상자를 만든다. 최소 높이를 보장하고 눈금 범위 밖은 잘라 낸다. */
export function blockBox(block: PlacedBlock, range: GridRange, pxPerMinute: number, minHeightPx = 18): BlockBox {
  const startMin = Math.max(block.startMin, range.startMin);
  const endMin = Math.min(Math.max(block.endMin, startMin), range.endMin);
  const bufferEnd = Math.min(Math.max(block.bufferEndMin, endMin), range.endMin);
  const top = (startMin - range.startMin) * pxPerMinute;
  const mainHeight = (endMin - startMin) * pxPerMinute;
  let bufferHeight = (bufferEnd - endMin) * pxPerMinute;
  let height = mainHeight + bufferHeight;
  if (height < minHeightPx) { bufferHeight = 0; height = minHeightPx; }
  const width = 100 / block.laneCount;
  return { top, height, bufferHeight, left: width * block.lane, width };
}
