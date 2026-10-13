import type { Customer } from './types';

/** 서버의 병합 함수가 보조 고객 메모 끝에 남기는 표시. 이 표시가 있으면 병합으로 보관된 고객이다. */
export const MERGE_ARCHIVE_MARKER = '[병합되어 보관됨';

export const isMergeArchive = (customer: Customer): boolean => customer.status === 'archived' && customer.notes.includes(MERGE_ARCHIVE_MARKER);

/** 복원 확인 문구. 병합으로 보관된 고객이 섞여 있으면 중복이 다시 생긴다고 알린다. */
export function restoreConfirmText(targets: readonly Customer[]): string {
  const base = targets.length === 1
    ? `'${targets[0]!.name}' 고객을 활성 고객으로 되돌립니다.`
    : `보관 고객 ${targets.length}명을 활성 고객으로 되돌립니다.`;
  const merged = targets.filter(isMergeArchive).length;
  return merged > 0 ? `${base} 이 중 ${merged}명은 다른 고객에 병합되어 보관된 고객이라 복원하면 중복 고객이 다시 생깁니다.` : base;
}
