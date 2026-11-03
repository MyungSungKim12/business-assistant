import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ApiClient } from '../../api/client';
import type { CallerSummary, Platform } from '../../platform/types';
import { loadCallerSummary } from './callerSummary';

vi.mock('../customers/visitFacts', () => ({ loadVisitFacts: async () => new Map([['customer', { last_actual_visit_date: '2026-10-20', next_appointment_at: null }]]) }));
vi.mock('../treatments/api', () => ({ treatmentApi: { list: async () => [
  { organization_id: 'org', customer_id: 'customer', treatment_date: '2026-10-19', status: 'completed', treatment_name: '피부 관리', practitioner: '담당자' },
  { organization_id: 'org', customer_id: 'other', treatment_date: '2026-10-22', status: 'completed', treatment_name: '다른 고객' },
] } }));

describe('progressive caller summary', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
  it('downloads only the selected protected photo and emits a bounded raster preview, not its signed URL', async () => {
    const close = vi.fn();
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ width: 100, height: 80, close })));
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ fillRect: vi.fn(), drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,/9j/AA==');
    const photo = { id: 'photo', customer_id: 'customer', organization_id: 'org', size_bytes: 100, content_type: 'image/jpeg', created_at: '2026-10-20', caption: '최근 사진' };
    const download = vi.fn(async () => new Uint8Array([1, 2]));
    const api = { getCallerProfile: async () => ({ customer_id: 'customer', notes: '', allergies: '', tags: [] }), listCustomerPhotos: async () => [photo], createPhotoDownloadUrl: async () => ({ photo, signed_url: 'https://protected.example/image?token=private' }) } as unknown as ApiClient;
    const states: CallerSummary[] = [];
    await loadCallerSummary(api, { downloadBinary: download } as unknown as Platform, 'org', 'customer', '+827012345678', state => states.push(state), () => true);
    expect(states.at(-1)!.photo).toBe('data:image/jpeg;base64,/9j/AA==');
    expect(JSON.stringify(states)).not.toContain('private');
    expect(download).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
  });
  it('preserves available data when photos fail, and filters other customer records', async () => {
    const states: CallerSummary[] = [];
    const api = { getCallerProfile: async () => ({ customer_id: 'customer', notes: '메모', allergies: '주의', tags: ['단골'] }), listCustomerPhotos: async () => { throw new Error('offline'); } } as unknown as ApiClient;
    await loadCallerSummary(api, {} as Platform, 'org', 'customer', '+827012345678', value => states.push(value), () => true);
    expect(states.at(-1)).toMatchObject({ notes: '메모', lastVisit: '2026-10-20', treatment: expect.stringContaining('피부 관리'), loading: false, errors: ['사진'] });
    expect(states.at(-1)!.treatment).not.toContain('다른 고객');
  });
  it('does not publish or start subsequent downloads after the scope is cancelled', async () => {
    let active = true;
    let resolve: (value: unknown) => void = () => {};
    const emit = vi.fn();
    const api = { getCallerProfile: () => new Promise(done => { resolve = done; }), listCustomerPhotos: async () => [] } as unknown as ApiClient;
    const running = loadCallerSummary(api, {} as Platform, 'org', 'customer', '+827012345678', emit, () => active);
    active = false;
    emit.mockClear();
    resolve({ customer_id: 'customer', notes: '이전 계정', allergies: '', tags: [] });
    await running;
    expect(emit).not.toHaveBeenCalled();
  });
});
