import type { Task } from '../../api/schemas';

export type ChecklistItem = { id: string; text: string; done: boolean };
export type Checklist = ChecklistItem[];

/** 서버가 라벨·체크리스트를 주지 않은 예전 응답도 빈 값으로 다룬다. */
export const labelsOf = (task: Pick<Task, 'labels'>): string[] => task.labels ?? [];
export const checklistOf = (task: Pick<Task, 'checklist'>): Checklist => task.checklist ?? [];
export const CHECKLIST_LIMIT = 50;
export const LABEL_LIMIT = 10;

/** 쉼표로 구분한 입력을 라벨 목록으로 바꾼다. 공백·빈 값·중복을 없애고 한도(10개, 각 30자)를 지킨다. */
export function parseLabels(text: string): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const part of text.split(',')) {
    const label = part.trim().slice(0, 30);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(label);
    if (labels.length >= LABEL_LIMIT) break;
  }
  return labels;
}

export const labelsText = (labels: string[]) => labels.join(', ');

export function checklistProgress(checklist: ChecklistItem[]): { done: number; total: number } {
  return { done: checklist.filter((item) => item.done).length, total: checklist.length };
}

export function addChecklistItem(checklist: ChecklistItem[], text: string, id: string): ChecklistItem[] {
  const trimmed = text.trim().slice(0, 200);
  if (!trimmed || checklist.length >= CHECKLIST_LIMIT) return checklist;
  return [...checklist, { id, text: trimmed, done: false }];
}

export const toggleChecklistItem = (checklist: ChecklistItem[], id: string): ChecklistItem[] => checklist.map((item) => (item.id === id ? { ...item, done: !item.done } : item));
export const removeChecklistItem = (checklist: ChecklistItem[], id: string): ChecklistItem[] => checklist.filter((item) => item.id !== id);
