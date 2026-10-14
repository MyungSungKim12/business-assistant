import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { ApiFailure } from '../errors.js';

const checklistItem = z.object({ id: z.string().min(1).max(64), text: z.string().trim().min(1).max(200), done: z.boolean() }).strict();
/** 할 일 체크리스트 항목(최대 50개, 047). */
export const checklistSchema = z.array(checklistItem).max(50);
const task = z.object({
  id: z.uuid(), organization_id: z.uuid(), created_by: z.uuid(), title: z.string(), description: z.string(), due_at: z.string().nullable(), status: z.string(), priority: z.string(),
  labels: z.array(z.string()).default([]), checklist: checklistSchema.default([]),
  recurrence: z.enum(['daily', 'weekly', 'monthly']).nullable().default(null), customer_id: z.uuid().nullable().default(null),
  assignee_id: z.uuid().nullable().default(null),
  /** 완료 기록(049). DB 트리거가 찍으므로 입력으로 받지 않는다. */
  completed_by: z.uuid().nullable().default(null), completed_at: z.string().nullable().default(null), completed_by_name: z.string().nullable().default(null),
});
const person = z.object({ user_id: z.uuid(), name: z.string() });
export type TaskPerson = z.infer<typeof person>;
export type TaskRecord = z.infer<typeof task>;
export type NewTask = Pick<TaskRecord, 'title' | 'description' | 'due_at' | 'priority'> & Partial<Pick<TaskRecord, 'labels' | 'checklist' | 'recurrence' | 'customer_id' | 'assignee_id'>>;

export function createTaskGateway(config: ServerConfig, fetcher: typeof fetch = fetch) {
  const headers = (token: string, write = false) => ({ apikey: config.APP_SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(write ? { Prefer: 'return=representation' } : {}) });
  async function request(token: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', params: Record<string, string>, body?: unknown) {
    const url = new URL('/rest/v1/tasks', config.APP_SUPABASE_URL);
    url.search = new URLSearchParams(params).toString();
    try {
      const response = await fetcher(url, { method, headers: headers(token, method !== 'GET'), body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (response.status === 401) throw new ApiFailure(401, 'Not authenticated');
      if (response.status === 403) throw new ApiFailure(403, 'Access denied');
      // 다른 조직 고객 연결(외래 키 위반) 등 입력 문제는 서버 오류가 아니라 잘못된 입력으로 알린다.
      if (response.status === 400 || response.status === 409) throw new ApiFailure(422, 'Invalid task input');
      if (!response.ok) throw new ApiFailure(503, 'Task service unavailable');
      return response.status === 204 ? [] : response.json();
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(503, 'Task service unavailable');
    }
  }
  async function userId(token: string) {
    const url = new URL('/auth/v1/user', config.APP_SUPABASE_URL);
    try {
      const response = await fetcher(url, { headers: headers(token), signal: AbortSignal.timeout(10_000), redirect: 'error' });
      const body: unknown = await response.json();
      const result = z.object({ id: z.uuid() }).safeParse(body);
      if (!response.ok || !result.success) throw new ApiFailure(response.status === 401 ? 401 : 503, response.status === 401 ? 'Not authenticated' : 'Task service unavailable');
      return result.data.id;
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(503, 'Task service unavailable');
    }
  }
  const rows = (value: unknown) => {
    const parsed = z.array(task).safeParse(value);
    if (!parsed.success) throw new ApiFailure(503, 'Task service unavailable');
    return parsed.data;
  };
  /** 담당자 선택용 구성원 이름 목록(이메일 없음). 모든 구성원이 읽을 수 있다. */
  async function people(token: string, organizationId: string): Promise<TaskPerson[]> {
    const url = new URL('/rest/v1/rpc/list_task_people', config.APP_SUPABASE_URL);
    try {
      const response = await fetcher(url, { method: 'POST', headers: headers(token), body: JSON.stringify({ p_org: organizationId }), signal: AbortSignal.timeout(10_000), redirect: 'error' });
      if (response.status === 401) throw new ApiFailure(401, 'Not authenticated');
      if (response.status === 403) throw new ApiFailure(403, 'Access denied');
      if (!response.ok) throw new ApiFailure(503, 'Task service unavailable');
      const parsed = z.array(person).safeParse(await response.json());
      if (!parsed.success) throw new ApiFailure(503, 'Task service unavailable');
      return parsed.data;
    } catch (error) {
      if (error instanceof ApiFailure) throw error;
      throw new ApiFailure(503, 'Task service unavailable');
    }
  }
  const select = 'id,organization_id,created_by,title,description,due_at,status,priority,labels,checklist,recurrence,customer_id,assignee_id,completed_by,completed_at,completed_by_name';
  return {
    people,
    async list(token: string, organizationId: string) { return rows(await request(token, 'GET', { select, organization_id: `eq.${organizationId}`, order: 'due_at.asc.nullslast,created_at.desc' })); },
    async create(token: string, organizationId: string, input: NewTask) {
      const result = rows(await request(token, 'POST', { select }, { ...input, organization_id: organizationId, created_by: await userId(token) }));
      if (!result[0]) throw new ApiFailure(503, 'Task service unavailable');
      return result[0];
    },
    async update(token: string, organizationId: string, taskId: string, patch: Partial<NewTask & Pick<TaskRecord, 'status'>>) {
      return rows(await request(token, 'PATCH', { select, id: `eq.${taskId}`, organization_id: `eq.${organizationId}` }, patch))[0] ?? null;
    },
    async remove(token: string, organizationId: string, taskId: string) {
      return rows(await request(token, 'DELETE', { select, id: `eq.${taskId}`, organization_id: `eq.${organizationId}` })).length > 0;
    },
  };
}

export type TaskGateway = ReturnType<typeof createTaskGateway>;
