import { describe, expect, it, vi } from 'vitest';
import { renderPopupSummary } from './popup-summary';

describe('caller summary presentation', () => {
  it('updates data without closing expanded notes, safely renders text and allows photo expansion', () => {
    const root = document.createElement('div');
    const summary = { notes: '<script>unsafe()</script>', allergies: '라텍스 주의', tags: ['단골'], photo: 'data:image/jpeg;base64,/9j/AA==', photoCaption: '최근 시술 사진' };
    renderPopupSummary(root, summary, vi.fn());
    expect(root.querySelector('script')).toBeNull();
    const notes = root.querySelector<HTMLDetailsElement>('[data-kind="notes"]')!;
    notes.open = true;
    renderPopupSummary(root, { ...summary, lastVisit: '2026-10-20' }, vi.fn());
    expect(root.querySelector<HTMLDetailsElement>('[data-kind="notes"]')!.open).toBe(true);
    expect(root.textContent).toContain('라텍스 주의');
    expect(root.querySelector<HTMLImageElement>('.call-photo')?.src).toBe(summary.photo);
    const photo = root.querySelector<HTMLDetailsElement>('[data-kind="photo"]')!;
    photo.open = true;
    expect(photo.open).toBe(true);
  });
  it('rejects arbitrary image URLs and provides retry without losing available notes', () => {
    const root = document.createElement('div'); const retry = vi.fn();
    renderPopupSummary(root, { notes: '응대 메모', errors: ['사진'], photo: 'https://untrusted.example/a.png' }, retry);
    expect(root.querySelector('img')).toBeNull();
    expect(root.textContent).toContain('응대 메모');
    root.querySelector('button')!.click(); expect(retry).toHaveBeenCalledOnce();
  });
});
