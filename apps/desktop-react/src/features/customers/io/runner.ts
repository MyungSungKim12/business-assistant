import { ApiError } from '../../../api/errors';
import { emptyCustomer, type Customer, type CustomerInput } from '../types';
import { findExisting, indexExisting } from './plan';
import type { ImportInput } from './validate';

export const IMPORT_CONCURRENCY = 3;

export type RunAction = 'create' | 'update' | 'skip';
export type RunStatus = 'pending' | 'done' | 'failed' | 'skipped' | 'canceled';

export interface RunItem {
  sourceRow: number;
  action: RunAction;
  /** action이 update일 때 덮어쓸 고객 */
  customerId?: string;
  input: ImportInput;
}

export interface RunState {
  status: RunStatus;
  /** 실패 사유(파일 내용은 담지 않는다) */
  message?: string;
  /** 서버가 처리했는지 알 수 없는 실패(연결 끊김·시간 초과·5xx). 재시도 전에 중복 생성 여부를 확인한다. */
  uncertain?: boolean;
  /** 재시도 전 확인에서 이미 등록된 것으로 확인된 행 */
  alreadyCreated?: boolean;
}

export type RunStates = Map<number, RunState>;

export interface RunDeps {
  create: (input: CustomerInput) => Promise<Customer>;
  update: (id: string, patch: Partial<CustomerInput>) => Promise<Customer>;
  /** 재시도 전, 서버에 이미 생성됐는지 확인하기 위한 현재 고객 목록 */
  reconcile?: () => Promise<Customer[]>;
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (states: RunStates) => void;
}

export function initialStates(items: readonly RunItem[]): RunStates {
  return new Map(items.map((item) => [item.sourceRow, { status: item.action === 'skip' ? 'skipped' : 'pending' } as RunState]));
}

/** 서버가 요청을 확실히 거절한 경우(4xx, 408·429 제외)는 처리되지 않았음이 분명하다. */
export function isDefinitiveFailure(error: unknown): boolean {
  return error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 408 && error.status !== 429;
}

export function failureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '로그인이 만료되었습니다. 다시 로그인한 뒤 재시도하세요.';
    if (error.status === 403) return '고객을 등록·수정할 권한이 없습니다.';
    if (error.status === 404) return '덮어쓸 고객을 찾을 수 없습니다. (삭제되었을 수 있습니다)';
    if (error.status === 409) return '다른 변경과 충돌했습니다.';
    if (error.status === 422 || error.status === 400) return '서버가 입력값을 받아들이지 않았습니다.';
    if (error.status === 429) return '요청이 많아 잠시 거절되었습니다. 잠시 후 재시도하세요.';
    if (error.status >= 500 || error.status === 0 || error.status === 408) return '서버 응답을 확인하지 못했습니다. 재시도하면 중복 등록 여부를 먼저 확인합니다.';
    return `요청에 실패했습니다. (${error.status})`;
  }
  return '네트워크 오류로 요청을 확인하지 못했습니다. 재시도하면 중복 등록 여부를 먼저 확인합니다.';
}

const isFatal = (error: unknown) => error instanceof ApiError && (error.status === 401 || error.status === 403);

/**
 * 항목을 동시 실행 수를 제한해 등록한다. states를 직접 갱신하고 onProgress로 알린다.
 * - done/skipped는 다시 실행하지 않는다(같은 요청의 재시도에서 이미 만든 행을 다시 만들지 않는다).
 * - pending/failed/canceled만 실행한다. 이전에 '결과를 알 수 없음'으로 실패한 생성은 목록을 다시 받아 이미 등록됐는지 확인한다.
 * - signal이 중단되면 새 요청을 시작하지 않고 남은 행을 canceled로 표시한다(진행 중 요청은 끝까지 기다린다).
 * - 401/403은 모든 행이 같은 이유로 실패하므로 즉시 멈춘다.
 */
export async function runImport(items: readonly RunItem[], states: RunStates, deps: RunDeps): Promise<void> {
  const notify = () => deps.onProgress?.(states);
  const queue = items.filter((item) => {
    const state = states.get(item.sourceRow);
    return item.action !== 'skip' && state !== undefined && state.status !== 'done' && state.status !== 'skipped';
  });
  // 직전 실행에서 결과를 알 수 없는 실패였던 생성 행(상태를 pending으로 되돌리기 전에 기억한다)
  const previouslyUncertain = new Set(
    queue.filter((item) => item.action === 'create' && states.get(item.sourceRow)?.uncertain === true).map((item) => item.sourceRow),
  );
  for (const item of queue) states.set(item.sourceRow, { status: 'pending' });
  notify();

  let skipUncertain = false;
  if (previouslyUncertain.size > 0 && deps.reconcile) {
    try {
      const index = indexExisting(await deps.reconcile());
      for (const item of queue) {
        if (!previouslyUncertain.has(item.sourceRow)) continue;
        if (findExisting(item.input, index)) states.set(item.sourceRow, { status: 'done', alreadyCreated: true });
      }
    } catch {
      skipUncertain = true;
    }
    notify();
  }

  let cursor = 0;
  let stopped = false;
  const worker = async () => {
    while (!stopped && !deps.signal?.aborted) {
      const item = queue[cursor];
      cursor += 1;
      if (!item) return;
      if (states.get(item.sourceRow)?.status === 'done') continue;
      if (skipUncertain && previouslyUncertain.has(item.sourceRow)) {
        states.set(item.sourceRow, { status: 'failed', uncertain: true, message: '이미 등록됐는지 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.' });
        notify();
        continue;
      }
      try {
        if (item.action === 'update' && item.customerId) await deps.update(item.customerId, item.input);
        else await deps.create({ ...emptyCustomer(), ...item.input });
        states.set(item.sourceRow, { status: 'done' });
      } catch (error) {
        states.set(item.sourceRow, { status: 'failed', message: failureMessage(error), uncertain: !isDefinitiveFailure(error) });
        if (isFatal(error)) stopped = true;
      }
      notify();
    }
  };
  const workers = Array.from({ length: Math.max(1, deps.concurrency ?? IMPORT_CONCURRENCY) }, () => worker());
  await Promise.all(workers);

  for (const item of queue) {
    if (states.get(item.sourceRow)?.status === 'pending') states.set(item.sourceRow, { status: 'canceled' });
  }
  notify();
}

export interface RunSummary {
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  canceled: number;
  alreadyCreated: number;
  pending: number;
}

export function summarizeRun(items: readonly RunItem[], states: RunStates): RunSummary {
  const summary: RunSummary = { created: 0, updated: 0, skipped: 0, failed: 0, canceled: 0, alreadyCreated: 0, pending: 0 };
  for (const item of items) {
    const state = states.get(item.sourceRow);
    if (!state) continue;
    if (state.status === 'done') {
      if (state.alreadyCreated) summary.alreadyCreated += 1;
      else if (item.action === 'update') summary.updated += 1;
      else summary.created += 1;
    } else if (state.status === 'skipped') summary.skipped += 1;
    else if (state.status === 'failed') summary.failed += 1;
    else if (state.status === 'canceled') summary.canceled += 1;
    else summary.pending += 1;
  }
  return summary;
}
