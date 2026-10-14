import { describe, expect, it } from 'vitest';
import { emptyForm } from './logic';
import { TEMPLATE_LIMITS, applyTemplateToConsultation, applyTemplateToForm, emptyTemplate, templateWouldOverwrite, templateWouldOverwriteConsultation, validateTemplate, type TreatmentTemplate } from './templates';

const template = (over: Partial<TreatmentTemplate> = {}): TreatmentTemplate => ({
  id: 't1', organization_id: 'o1', name: '기본 페이셜', category: '피부', treatment_name: '수분 관리', notes: '1. 클렌징\n2. 팩',
  consultation_goal: '수분 개선', consultation_plan: '4주 간격', version: 1, updated_at: '2026-10-14T00:00:00Z', ...over,
});
const form = (over: Record<string, string> = {}) => ({ ...emptyForm('2026-10-14'), ...over });

describe('applyTemplateToForm', () => {
  it('시술명·분류·내용을 채우되 시술일·담당자·금액·다음 방문일은 건드리지 않는다', () => {
    const next = applyTemplateToForm(form({ practitioner: '김담당', amount: '15000', next_visit_date: '2026-11-01' }), template());
    expect(next).toMatchObject({ treatment_name: '수분 관리', category: '피부', notes: '1. 클렌징\n2. 팩', practitioner: '김담당', amount: '15000', next_visit_date: '2026-11-01', treatment_date: '2026-10-14' });
  });
  it('템플릿에서 비어 있는 칸은 현재 입력을 유지하고, 시술명이 둘 다 비면 템플릿 이름을 쓴다', () => {
    const sparse = template({ treatment_name: '', category: '', notes: '' });
    expect(applyTemplateToForm(form({ treatment_name: '내 시술', category: '내 분류', notes: '내 메모' }), sparse)).toMatchObject({ treatment_name: '내 시술', category: '내 분류', notes: '내 메모' });
    expect(applyTemplateToForm(form(), sparse).treatment_name).toBe('기본 페이셜');
  });
});

describe('templateWouldOverwrite', () => {
  it('빈 폼이거나 같은 값이면 확인이 필요 없다', () => {
    expect(templateWouldOverwrite(form(), template())).toBe(false);
    expect(templateWouldOverwrite(form({ treatment_name: '수분 관리', category: '피부', notes: '1. 클렌징\n2. 팩' }), template())).toBe(false);
  });
  it('이미 다른 내용을 썼으면 확인이 필요하다', () => {
    expect(templateWouldOverwrite(form({ notes: '직접 쓴 메모' }), template())).toBe(true);
    expect(templateWouldOverwrite(form({ treatment_name: '다른 시술' }), template())).toBe(true);
  });
  it('템플릿이 비운 칸은 덮어쓰지 않으므로 확인하지 않는다', () => {
    expect(templateWouldOverwrite(form({ notes: '직접 쓴 메모' }), template({ notes: '' }))).toBe(false);
  });
});

describe('상담 템플릿', () => {
  it('목표·예정 관리를 채우고 비어 있는 칸은 유지한다', () => {
    expect(applyTemplateToConsultation('', '', template())).toEqual({ goal: '수분 개선', plan: '4주 간격' });
    expect(applyTemplateToConsultation('내 목표', '내 계획', template({ consultation_goal: '', consultation_plan: '' }))).toEqual({ goal: '내 목표', plan: '내 계획' });
  });
  it('이미 다른 내용을 썼을 때만 덮어쓰기 확인이 필요하다', () => {
    expect(templateWouldOverwriteConsultation('', '', template())).toBe(false);
    expect(templateWouldOverwriteConsultation('수분 개선', '4주 간격', template())).toBe(false);
    expect(templateWouldOverwriteConsultation('다른 목표', '', template())).toBe(true);
  });
});

describe('validateTemplate', () => {
  it('이름은 필수이고 공백은 정리한다', () => {
    expect(validateTemplate(emptyTemplate())).toEqual({ error: '템플릿 이름을 입력하세요.' });
    expect(validateTemplate({ ...emptyTemplate(), name: '  이름  ', category: ' 분류 ' })).toEqual({ value: { ...emptyTemplate(), name: '이름', category: '분류' } });
  });
  it.each([
    ['name', TEMPLATE_LIMITS.name], ['category', TEMPLATE_LIMITS.category], ['treatment_name', TEMPLATE_LIMITS.treatment_name],
    ['notes', TEMPLATE_LIMITS.notes], ['consultation_goal', TEMPLATE_LIMITS.consultation_goal], ['consultation_plan', TEMPLATE_LIMITS.consultation_plan],
  ] as const)('%s 한도를 넘으면 안내한다', (key, limit) => {
    const ok = validateTemplate({ ...emptyTemplate(), name: '이름', [key]: key === 'name' ? '가'.repeat(limit) : '가'.repeat(limit) });
    expect('value' in ok).toBe(true);
    const bad = validateTemplate({ ...emptyTemplate(), name: '이름', [key]: '가'.repeat(limit + 1) });
    expect('error' in bad).toBe(true);
  });
});
