import type { CallerSummary } from '../../platform/types';

const versions = new WeakMap<HTMLElement, string>();
function text(tag: string, value: string, className = '') {
  const node = document.createElement(tag); node.textContent = value; node.className = className; return node;
}
/** User-entered strings are text, and image sources must be bounded raster previews. */
export function renderPopupSummary(root: HTMLElement, summary: CallerSummary | undefined, retry: () => void) {
  const version = JSON.stringify(summary);
  if (versions.get(root) === version) return;
  versions.set(root, version);
  const opened = new Set([...root.querySelectorAll<HTMLDetailsElement>('details[open]')].map(node => node.dataset.kind));
  root.replaceChildren();
  if (!summary) return;
  if (summary.tags?.length) root.append(text('p', summary.tags.join(' · '), 'call-tags'));
  if (summary.allergies) root.append(text('p', `주의사항: ${summary.allergies}`, 'call-caution'));
  if (summary.notes !== undefined) {
    root.append(text('p', summary.notes || '등록된 고객 메모 없음', 'call-notes-preview'));
    if (summary.notes) {
      const details = document.createElement('details'); details.dataset.kind = 'notes'; details.open = opened.has('notes');
      details.append(text('summary', '메모 전체 보기'), text('p', summary.notes)); root.append(details);
    }
  }
  for (const [label, value] of [['최근 방문', summary.lastVisit], ['최근 시술', summary.treatment], ['다음 예약', summary.nextAppointment]]) {
    if (value) root.append(text('p', `${label}: ${value}`, 'call-fact'));
  }
  if (summary.photo && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(summary.photo) && summary.photo.length <= 200_000) {
    const details = document.createElement('details'); details.dataset.kind = 'photo'; details.open = opened.has('photo');
    const label = document.createElement('summary');
    const small = document.createElement('img'); small.src = summary.photo; small.alt = '최근 등록 고객 사진'; small.width = 70; small.height = 54;
    label.append(small, document.createTextNode(' 사진 확대'));
    const image = document.createElement('img'); image.src = summary.photo; image.alt = summary.photoCaption || '고객 사진'; image.className = 'call-photo';
    details.append(label, image, text('p', summary.photoCaption || '최근 등록 사진')); root.append(details);
  } else if (summary.photoCaption) root.append(text('p', summary.photoCaption));
  if (summary.loading) root.append(text('p', '고객 정보 불러오는 중…', 'call-loading'));
  if (summary.errors?.length) {
    const error = text('p', `${summary.errors.join(' · ')} 조회 실패 `, 'call-loading');
    const button = document.createElement('button'); button.type = 'button'; button.textContent = '다시 불러오기'; button.onclick = retry;
    error.append(button); root.append(error);
  }
}
