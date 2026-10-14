import { describe, expect, it } from 'vitest';
import { CHECKLIST_LIMIT, addChecklistItem, checklistProgress, parseLabels, removeChecklistItem, toggleChecklistItem } from './checklistLogic';

describe('parseLabels', () => {
  it('쉼표로 나누고 공백·빈 값·중복을 없앤다', () => {
    expect(parseLabels(' 재고 , 월말,, 재고 ,  ')).toEqual(['재고', '월말']);
    expect(parseLabels('')).toEqual([]);
  });
  it('각 30자, 최대 10개로 자른다', () => {
    expect(parseLabels('가'.repeat(40))[0]).toHaveLength(30);
    expect(parseLabels(Array.from({ length: 15 }, (_, i) => `l${i}`).join(','))).toHaveLength(10);
  });
});

describe('checklist 변경', () => {
  const base = [{ id: 'a', text: '상자', done: false }, { id: 'b', text: '청소', done: true }];
  it('진행 수를 센다', () => expect(checklistProgress(base)).toEqual({ done: 1, total: 2 }));
  it('항목을 추가하되 빈 글과 한도 초과는 무시한다', () => {
    expect(addChecklistItem(base, '  새 항목 ', 'c')).toEqual([...base, { id: 'c', text: '새 항목', done: false }]);
    expect(addChecklistItem(base, '   ', 'c')).toBe(base);
    const full = Array.from({ length: CHECKLIST_LIMIT }, (_, i) => ({ id: String(i), text: 't', done: false }));
    expect(addChecklistItem(full, '추가', 'x')).toBe(full);
  });
  it('체크 전환과 삭제는 원본을 바꾸지 않는다', () => {
    expect(toggleChecklistItem(base, 'a')[0].done).toBe(true);
    expect(removeChecklistItem(base, 'a')).toEqual([base[1]]);
    expect(base[0].done).toBe(false);
  });
});
