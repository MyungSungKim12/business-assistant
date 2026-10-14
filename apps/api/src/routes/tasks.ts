import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../errors.js';
import { bearerToken } from './organizations.js';
import { checklistSchema, type TaskGateway } from '../supabase/tasks.js';

// 필드 정의는 한 곳에 두고, 생성에는 기본값을, 수정(PATCH)에는 "보낸 필드만"을 쓴다.
// 기본값이 붙은 스키마에 partial()을 쓰면 빈 필드가 기본값으로 채워져 설명·기한·우선순위가 지워지므로 수정용은 따로 만든다.
const fields = {
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5_000),
  due_at: z.iso.datetime().nullable(),
  priority: z.enum(['low', 'normal', 'high']),
  labels: z.array(z.string().trim().min(1).max(30)).max(10).refine((value) => new Set(value).size === value.length),
  checklist: checklistSchema,
  recurrence: z.enum(['daily', 'weekly', 'monthly']).nullable(),
  customer_id: z.uuid().nullable(),
};
const taskInput = z.object({
  title: fields.title, description: fields.description.default(''), due_at: fields.due_at.default(null), priority: fields.priority.default('normal'),
  labels: fields.labels.default([]), checklist: fields.checklist.default([]), recurrence: fields.recurrence.default(null), customer_id: fields.customer_id.default(null),
}).strict().refine((value) => value.recurrence === null || value.due_at !== null, { message: '반복하려면 기한이 필요하다' });
const taskPatch = z.object({
  title: fields.title.optional(), description: fields.description.optional(), due_at: fields.due_at.optional(), priority: fields.priority.optional(),
  labels: fields.labels.optional(), checklist: fields.checklist.optional(), recurrence: fields.recurrence.optional(), customer_id: fields.customer_id.optional(), status: z.enum(['open', 'in_progress', 'done', 'canceled']).optional(),
}).strict().refine((value) => Object.keys(value).length > 0);

export function registerTaskRoutes(app: FastifyInstance, organizations: Pick<{ requireAccess(token: string, id: string, feature: string, write?: boolean): Promise<string> }, 'requireAccess'> | undefined, tasks?: TaskGateway): void {
  function service(request: FastifyRequest) {
    const token = bearerToken(request);
    const params = z.object({ organizationId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid organization ID');
    if (!organizations || !tasks) throw new ApiFailure(503, 'Task service unavailable');
    return { token, organizationId: params.data.organizationId };
  }
  app.get('/api/v1/organizations/:organizationId/tasks', async (request) => {
    const current = service(request);
    await organizations!.requireAccess(current.token, current.organizationId, 'task.basic');
    return tasks!.list(current.token, current.organizationId);
  });
  app.post('/api/v1/organizations/:organizationId/tasks', async (request) => {
    const current = service(request);
    const input = taskInput.safeParse(request.body);
    if (!input.success) throw new ApiFailure(422, 'Invalid task input');
    await organizations!.requireAccess(current.token, current.organizationId, 'task.basic');
    return tasks!.create(current.token, current.organizationId, input.data);
  });
  app.patch('/api/v1/organizations/:organizationId/tasks/:taskId', async (request) => {
    const current = service(request);
    const params = z.object({ taskId: z.uuid() }).safeParse(request.params);
    const input = taskPatch.safeParse(request.body);
    if (!params.success || !input.success) throw new ApiFailure(422, 'Invalid task input');
    await organizations!.requireAccess(current.token, current.organizationId, 'task.basic');
    const saved = await tasks!.update(current.token, current.organizationId, params.data.taskId, input.data);
    if (!saved) throw new ApiFailure(404, 'Task not found');
    return saved;
  });
  app.delete('/api/v1/organizations/:organizationId/tasks/:taskId', async (request, reply) => {
    const current = service(request);
    const params = z.object({ taskId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid task ID');
    await organizations!.requireAccess(current.token, current.organizationId, 'task.basic');
    if (!await tasks!.remove(current.token, current.organizationId, params.data.taskId)) throw new ApiFailure(404, 'Task not found');
    return reply.code(204).send();
  });
}
