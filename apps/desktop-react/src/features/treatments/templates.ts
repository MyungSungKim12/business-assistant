import { z } from 'zod';
import type { ApiClient } from '../../api/client';
import type { FormState } from './logic';

/** TRT-12 시술 프로토콜 템플릿. 불러올 때 값을 복사할 뿐 시술 기록과 연결되지 않는다. */
export const templateSchema = z.object({
  id: z.string(), organization_id: z.string(), name: z.string(), category: z.string(), treatment_name: z.string(), notes: z.string(),
  consultation_goal: z.string(), consultation_plan: z.string(), version: z.number(), updated_at: z.string(),
});
export const templatesSchema = z.array(templateSchema);
export type TreatmentTemplate = z.infer<typeof templateSchema>;

export type TemplateInput = Pick<TreatmentTemplate, 'name' | 'category' | 'treatment_name' | 'notes' | 'consultation_goal' | 'consultation_plan'>;
export const emptyTemplate = (): TemplateInput => ({ name: '', category: '', treatment_name: '', notes: '', consultation_goal: '', consultation_plan: '' });

export const TEMPLATE_LIMITS = { name: 120, category: 100, treatment_name: 200, notes: 10_000, consultation_goal: 2_000, consultation_plan: 5_000 } as const;

const base = (organizationId: string) => `/organizations/${organizationId}/treatment-templates`;
export const templateApi = {
  list: (api: ApiClient, organizationId: string) => api.call('GET', base(organizationId), templatesSchema),
  create: (api: ApiClient, organizationId: string, input: TemplateInput) => api.call('POST', base(organizationId), templateSchema, input),
  update: (api: ApiClient, organizationId: string, templateId: string, input: Partial<TemplateInput> & { expected_version: number }) =>
    api.call('PATCH', `${base(organizationId)}/${templateId}`, templateSchema, input),
  remove: (api: ApiClient, organizationId: string, templateId: string) => api.callVoid('DELETE', `${base(organizationId)}/${templateId}`),
};

/** 입력 폼에 이미 채워 둔 내용이 템플릿이 덮어쓸 값과 다른지(덮어쓰기 전에 확인할지). */
export function templateWouldOverwrite(form: FormState, template: TreatmentTemplate): boolean {
  const differs = (current: string, next: string) => next.trim() !== '' && current.trim() !== '' && current !== next;
  return differs(form.treatment_name, template.treatment_name) || differs(form.category, template.category) || differs(form.notes, template.notes);
}

/** 템플릿 값을 폼에 채운다. 템플릿에서 비어 있는 칸은 현재 입력을 그대로 둔다. 시술일·담당자·금액·다음 방문일은 건드리지 않는다. */
export function applyTemplateToForm(form: FormState, template: TreatmentTemplate): FormState {
  return {
    ...form,
    treatment_name: template.treatment_name.trim() ? template.treatment_name : form.treatment_name || template.name,
    category: template.category.trim() ? template.category : form.category,
    notes: template.notes.trim() ? template.notes : form.notes,
  };
}

export function templateWouldOverwriteConsultation(goal: string, plan: string, template: TreatmentTemplate): boolean {
  const differs = (current: string, next: string) => next.trim() !== '' && current.trim() !== '' && current !== next;
  return differs(goal, template.consultation_goal) || differs(plan, template.consultation_plan);
}

export function applyTemplateToConsultation(goal: string, plan: string, template: TreatmentTemplate): { goal: string; plan: string } {
  return {
    goal: template.consultation_goal.trim() ? template.consultation_goal : goal,
    plan: template.consultation_plan.trim() ? template.consultation_plan : plan,
  };
}

/** 입력이 서버 한도를 지키는지 검사한다. 통과하면 정리된 값, 아니면 안내 문구. */
export function validateTemplate(input: TemplateInput): { value: TemplateInput } | { error: string } {
  const value: TemplateInput = {
    name: input.name.trim(), category: input.category.trim(), treatment_name: input.treatment_name.trim(),
    notes: input.notes, consultation_goal: input.consultation_goal, consultation_plan: input.consultation_plan,
  };
  if (!value.name) return { error: '템플릿 이름을 입력하세요.' };
  if (value.name.length > TEMPLATE_LIMITS.name) return { error: `템플릿 이름은 ${TEMPLATE_LIMITS.name}자 이내로 입력하세요.` };
  if (value.category.length > TEMPLATE_LIMITS.category) return { error: `분류는 ${TEMPLATE_LIMITS.category}자 이내로 입력하세요.` };
  if (value.treatment_name.length > TEMPLATE_LIMITS.treatment_name) return { error: `시술명은 ${TEMPLATE_LIMITS.treatment_name}자 이내로 입력하세요.` };
  if (value.notes.length > TEMPLATE_LIMITS.notes) return { error: `시술 내용은 ${TEMPLATE_LIMITS.notes.toLocaleString('ko-KR')}자 이내로 입력하세요.` };
  if (value.consultation_goal.length > TEMPLATE_LIMITS.consultation_goal) return { error: `상담 목표는 ${TEMPLATE_LIMITS.consultation_goal.toLocaleString('ko-KR')}자 이내로 입력하세요.` };
  if (value.consultation_plan.length > TEMPLATE_LIMITS.consultation_plan) return { error: `예정 관리 내용은 ${TEMPLATE_LIMITS.consultation_plan.toLocaleString('ko-KR')}자 이내로 입력하세요.` };
  return { value };
}
