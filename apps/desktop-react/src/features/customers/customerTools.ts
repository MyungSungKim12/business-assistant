import { z } from 'zod';
import type { ApiClient } from '../../api/client';
import { ApiError } from '../../api/errors';
import { customerSchema } from '../../api/schemas';
import type { MergeResolved } from './duplicates';
import type { Customer } from './types';

const tagCounts = z.array(z.object({ tag: z.string(), count: z.number().int() }));
const updated = z.object({ updated: z.number().int() }).loose();
const duplicateGroups = z.array(z.object({ reason: z.enum(['phone', 'email']), key: z.string(), customers: z.array(customerSchema) }));
const mergeResult = z.object({ primary: customerSchema, secondary_id: z.string(), moved: z.record(z.string(), z.number()) }).loose();

export type TagCount = z.infer<typeof tagCounts>[number];
export type MergeOutcome = z.infer<typeof mergeResult>;

const base = (organizationId: string) => `/organizations/${organizationId}`;

export const listTags = (api: ApiClient, organizationId: string): Promise<TagCount[]> => api.call('GET', `${base(organizationId)}/customer-tags`, tagCounts);
export const renameTag = (api: ApiClient, organizationId: string, from: string, to: string) => api.call('POST', `${base(organizationId)}/customer-tags/rename`, updated, { from, to });
export const mergeTags = (api: ApiClient, organizationId: string, from: string[], to: string) => api.call('POST', `${base(organizationId)}/customer-tags/merge`, updated, { from, to });
export const deleteTag = (api: ApiClient, organizationId: string, tag: string) => api.call('POST', `${base(organizationId)}/customer-tags/delete`, updated, { tag });

/** 서버 전체 기준 중복 후보. 구버전 서버 등으로 실패하면 null(화면은 불러온 고객만으로 찾는다). */
export async function fetchServerDuplicates(api: ApiClient, organizationId: string): Promise<Customer[] | null> {
  try {
    const groups = await api.call('GET', `${base(organizationId)}/customers/duplicates`, duplicateGroups);
    const byId = new Map<string, Customer>();
    for (const group of groups) for (const customer of group.customers) byId.set(customer.id, customer);
    return [...byId.values()];
  } catch {
    return null;
  }
}

/** 대표 고객(primaryId)에 보조 고객(secondaryId)을 합친다. 같은 operationId로 다시 보내도 한 번만 반영된다. */
export function mergeCustomers(api: ApiClient, organizationId: string, primaryId: string, secondaryId: string, operationId: string, resolved: MergeResolved): Promise<MergeOutcome> {
  return api.call('POST', `${base(organizationId)}/customers/${primaryId}/merge`, mergeResult, { secondary_id: secondaryId, operation_id: operationId, resolved });
}

/** 병합·태그 작업 실패를 사용자 문구로 바꾼다. */
export function toolErrorText(error: unknown, fallback: string): string {
  const status = error instanceof ApiError ? error.status : undefined;
  if (status === 403) return '이 작업은 소유자·관리자만 할 수 있습니다.';
  if (status === 409) return '이미 병합되었거나 다른 곳에서 먼저 바뀌었습니다. 목록을 새로 불러온 뒤 다시 확인해 주세요. (시술 판매 인계 기록이 있는 고객은 병합할 수 없습니다.)';
  if (status === 404) return '고객을 찾을 수 없습니다. 목록을 새로 불러와 주세요.';
  if (status === 422) return '입력 값이 올바르지 않습니다.';
  return fallback;
}
