import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import type { OrgAccess } from '../catalog/routes.js';
import type { ManagementGateway } from './gateway.js';

const query = z.object({ from_date: z.iso.date(), to_date: z.iso.date() });
const DAY = 86_400_000;

/** 관리 미리보기(Python api/management.py): finance.basic 기능 + 관리자(owner/admin)만. 기간은 최대 366일. */
export function registerManagementRoutes(app: FastifyInstance, organizations: OrgAccess | undefined, gateway: ManagementGateway | undefined): void {
  app.get('/api/v1/organizations/:organizationId/management-preview', async (request) => {
    const token = bearerToken(request);
    const params = z.object({ organizationId: z.uuid() }).safeParse(request.params);
    if (!params.success) throw new ApiFailure(422, 'Invalid organization ID');
    const period = query.safeParse(request.query);
    if (!period.success) throw new ApiFailure(422, 'Invalid report period');
    const days = (Date.parse(period.data.to_date) - Date.parse(period.data.from_date)) / DAY;
    if (days < 0 || days > 366) throw new ApiFailure(422, 'Invalid report period');
    if (!organizations || !gateway) throw new ApiFailure(503, 'Management service unavailable');
    await organizations.requireAccess(token, params.data.organizationId, 'finance.basic', true);
    return gateway.getPreview(token, params.data.organizationId, period.data.from_date, period.data.to_date);
  });
}
