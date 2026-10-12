const prefix = 'ba-grid:';

export function loadWidths(storageKey: string | undefined): Record<string, number> {
  if (!storageKey) return {};
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(`${prefix}${storageKey}`) ?? '{}');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1]) && entry[1] >= 40),
    );
  } catch {
    return {};
  }
}

export function saveWidths(storageKey: string | undefined, widths: Record<string, number>): void {
  if (!storageKey) return;
  try {
    localStorage.setItem(`${prefix}${storageKey}`, JSON.stringify(widths));
  } catch {
    // Private browsing and storage policies may disable localStorage.
  }
}
