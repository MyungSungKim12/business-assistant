import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../errors.js';
import { bearerToken } from './organizations.js';
import type { TaskGateway } from '../supabase/tasks.js';

const taskInput = z.object({
  title: z.string().trim().min(1).max(300),
  description: z.string().max(5_000).default(''),
  due_at: z.iso.datetime().nullable().default(null),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
}).strict();
const taskPatch = taskInput.partial().extend({ status: z.enum(['open', 'in_progress', 'done', 'canceled']).optional() }).refine((value) => Object.keys(value).length > 0);

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
