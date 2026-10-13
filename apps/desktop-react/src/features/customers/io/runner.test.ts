import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../api/errors';
import type { Customer } from '../types';
import { initialStates, runImport, summarizeRun, type RunDeps, type RunItem } from './runner';

const customer = (patch: Partial<Customer> = {}): Customer => ({
  id: '11111111-1111-4111-8111-111111111111', organization_id: '22222222-2222-4222-8222-222222222222', name: '김', email: null, phone: null, notes: '',
  birth_date: null, skin_type: null, concerns: [], allergies: '', last_visit_date: null, next_visit_date: null, tags: [], status: 'active', ...patch,
});
const items = (count: number, action: RunItem['action'] = 'create'): RunItem[] =>
  Array.from({ length: count }, (_, index) => ({ sourceRow: index + 2, action, customerId: action === 'update' ? 'id' : undefined, input: { name: `고객${index}`, phone: `010-0000-${String(1000 + index)}` } }));
const apiError = (status: number) => new ApiError(status, `HTTP_${status}`, 'x', status >= 500);

describe('runImport', () => {
  it('never runs more than the concurrency limit at once and completes everything', async () => {
    let active = 0;
    let peak = 0;
    const create: RunDeps['create'] = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return customer();
    };
    const list = items(10);
    const states = initialStates(list);
    await runImport(list, states, { create, update: vi.fn(), concurrency: 3 });
    expect(peak).toBe(3);
    expect(summarizeRun(list, states).created).toBe(10);
  });

  it('creates with defaults, patches only provided fields on overwrite, and never calls the API for skipped rows', async () => {
    const create = vi.fn(async () => customer());
    const update = vi.fn(async () => customer());
    const list: RunItem[] = [
      { sourceRow: 2, action: 'create', input: { name: '신규' } },
      { sourceRow: 3, action: 'update', customerId: 'abc', input: { name: '갱신', phone: '010-1' } },
      { sourceRow: 4, action: 'skip', input: { name: '건너뜀' } },
    ];
    const states = initialStates(list);
    await runImport(list, states, { create, update });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: '신규', tags: [], status: 'active', notes: '' }));
    expect(update).toHaveBeenCalledWith('abc', { name: '갱신', phone: '010-1' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(summarizeRun(list, states)).toMatchObject({ created: 1, updated: 1, skipped: 1, failed: 0 });
  });

  it('retries only failed rows and never recreates rows that already succeeded', async () => {
    const list = items(4);
    const states = initialStates(list);
    const create = vi.fn(async (input: { name: string }) => {
      if (input.name === '고객1') throw apiError(422);
      return customer();
    });
    await runImport(list, states, { create, update: vi.fn() });
    expect(summarizeRun(list, states)).toMatchObject({ created: 3, failed: 1 });
    expect(states.get(3)?.uncertain).toBe(false);

    create.mockImplementation(async () => customer());
    await runImport(list, states, { create, update: vi.fn() });
    expect(create).toHaveBeenCalledTimes(5);
    expect(summarizeRun(list, states)).toMatchObject({ created: 4, failed: 0 });
  });

  it('checks the server before retrying a create whose outcome was unknown, and does not recreate it', async () => {
    const list = items(2);
    const states = initialStates(list);
    const create = vi.fn(async (input: { name: string }) => {
      if (input.name === '고객0') throw apiError(503);
      return customer();
    });
    await runImport(list, states, { create, update: vi.fn() });
    expect(states.get(2)).toMatchObject({ status: 'failed', uncertain: true });

    const reconcile = vi.fn(async () => [customer({ phone: '01000001000' })]);
    await runImport(list, states, { create, update: vi.fn(), reconcile });
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(2);
    expect(summarizeRun(list, states)).toMatchObject({ created: 1, alreadyCreated: 1, failed: 0 });
  });

  it('keeps an unknown-outcome row failed when the server cannot be checked', async () => {
    const list = items(1);
    const states = initialStates(list);
    const create = vi.fn(async () => { throw new Error('network'); });
    await runImport(list, states, { create, update: vi.fn() });
    await runImport(list, states, { create, update: vi.fn(), reconcile: async () => { throw new Error('offline'); } });
    expect(create).toHaveBeenCalledTimes(1);
    expect(states.get(2)?.status).toBe('failed');
  });

  it('stops starting new requests after cancel and marks the rest canceled, then resumes on retry', async () => {
    const list = items(8);
    const states = initialStates(list);
    const controller = new AbortController();
    let calls = 0;
    const create = vi.fn(async () => {
      calls += 1;
      if (calls === 2) controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 5));
      return customer();
    });
    await runImport(list, states, { create, update: vi.fn(), concurrency: 1, signal: controller.signal });
    const summary = summarizeRun(list, states);
    expect(summary.created).toBe(2);
    expect(summary.canceled).toBe(6);

    await runImport(list, states, { create, update: vi.fn(), concurrency: 1 });
    expect(summarizeRun(list, states)).toMatchObject({ created: 8, canceled: 0 });
    expect(create).toHaveBeenCalledTimes(8);
  });

  it('stops everything on a permission error instead of failing every row', async () => {
    const list = items(30);
    const states = initialStates(list);
    const create = vi.fn(async () => { throw apiError(403); });
    await runImport(list, states, { create, update: vi.fn(), concurrency: 3 });
    expect(create.mock.calls.length).toBeLessThanOrEqual(3);
    const summary = summarizeRun(list, states);
    expect(summary.failed + summary.canceled).toBe(30);
  });

  it('reports progress', async () => {
    const list = items(3);
    const states = initialStates(list);
    const onProgress = vi.fn();
    await runImport(list, states, { create: async () => customer(), update: vi.fn(), onProgress });
    expect(onProgress).toHaveBeenCalled();
  });
});
