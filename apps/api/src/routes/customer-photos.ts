import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../errors.js';
import { bearerToken } from './organizations.js';
export const customerPhotoSchema = z.object({ id: z.uuid(), organization_id: z.uuid(), customer_id: z.uuid(), original_name: z.string(), storage_path: z.string(), content_type: z.string(), size_bytes: z.number(), caption: z.string(), created_at: z.string() });
export type CustomerPhoto = z.infer<typeof customerPhotoSchema>;
export const photoUploadStatusSchema = z.object({
    items: z.array(z.object({id:z.uuid(),organization_id:z.uuid(),customer_id:z.uuid(),original_name:z.string(),upload_state:z.enum(['pending','failed']),created_at:z.string(),upload_failure_reason:z.enum(['object_missing','metadata_mismatch','upload_not_completed']).nullable(),upload_failed_at:z.string().nullable()})),
    limit:z.literal(250),has_more:z.boolean(),maintenance:z.object({attempted_at:z.string(),finished_at:z.string().nullable(),state:z.enum(['succeeded','failed']),error_code:z.string().nullable()}).nullable(),
});
export type PhotoUploadStatus = z.infer<typeof photoUploadStatusSchema>;
/** 휴지통(삭제한 사진) 항목: 삭제 시각·사람은 DB가 기록한다(053). */
export const trashedPhotoSchema = customerPhotoSchema.extend({ archived_at: z.string().nullable(), archived_by_name: z.string().nullable() });
export type TrashedPhoto = z.infer<typeof trashedPhotoSchema>;
export type SignedPhoto = {
    photo: CustomerPhoto;
    signed_url: string;
    expires_in: number;
};
export type CustomerPhotoGateway = {
    uploadStatus?(token:string,organizationId:string,customerId:string):Promise<PhotoUploadStatus>;
    completeUpload?(token: string, organizationId: string, customerId: string, photoId: string): Promise<CustomerPhoto>;
    list(token: string, organizationId: string, customerId: string): Promise<CustomerPhoto[]>;
    createUpload(token: string, organizationId: string, customerId: string, input: {
        original_name: string;
        content_type: string;
        size_bytes: number;
        caption: string;
    }): Promise<SignedPhoto>;
    createDownload(token: string, organizationId: string, customerId: string, photoId: string): Promise<SignedPhoto>;
    archive(token: string, organizationId: string, customerId: string, photoId: string): Promise<CustomerPhoto | null>;
    listTrash?(token: string, organizationId: string, customerId: string): Promise<TrashedPhoto[]>;
    restore?(token: string, organizationId: string, customerId: string, photoId: string): Promise<CustomerPhoto | null>;
};
const identifiers = z.object({ organizationId: z.uuid(), customerId: z.uuid() });
const upload = z.object({ original_name: z.string().trim().min(1).max(255), content_type: z.enum(['image/jpeg', 'image/png', 'image/webp']), size_bytes: z.number().int().positive().max(10 * 1024 * 1024), caption: z.string().trim().max(500).default('') }).strict();
export function registerCustomerPhotoRoutes(app: FastifyInstance, organizations: Pick<{
    requireAccess(token: string, id: string, feature: string, write?: boolean): Promise<string>;
}, 'requireAccess'> | undefined, photos?: CustomerPhotoGateway) { function service(request: FastifyRequest) { const token = bearerToken(request); if (!organizations || !photos)
    throw new ApiFailure(503, 'Customer photo service unavailable'); const p = identifiers.safeParse(request.params); if (!p.success)
    throw new ApiFailure(422, 'Invalid customer ID'); return { token, ...p.data, organizations, photos }; } app.get('/api/v1/organizations/:organizationId/customers/:customerId/photos/upload-status', async (request) => { const c = service(request); await c.organizations.requireAccess(c.token,c.organizationId,'crm.basic',true); if (!c.photos.uploadStatus) throw new ApiFailure(503,'Photo upload status unavailable'); return c.photos.uploadStatus(c.token,c.organizationId,c.customerId); }); app.get('/api/v1/organizations/:organizationId/customers/:customerId/photos', async (request) => { const c = service(request); await c.organizations.requireAccess(c.token, c.organizationId, 'crm.basic'); return c.photos.list(c.token, c.organizationId, c.customerId); }); app.get('/api/v1/organizations/:organizationId/customers/:customerId/photos/trash', async (request) => { const c = service(request); if (!c.photos.listTrash)
    throw new ApiFailure(503, 'Customer photo service unavailable'); await c.organizations.requireAccess(c.token, c.organizationId, 'crm.basic', true); return c.photos.listTrash(c.token, c.organizationId, c.customerId); }); app.post('/api/v1/organizations/:organizationId/customers/:customerId/photos/:photoId/restore', async (request) => { const c = service(request), id = z.object({ photoId: z.uuid() }).safeParse(request.params); if (!id.success)
    throw new ApiFailure(422, 'Invalid customer photo ID'); if (!c.photos.restore)
    throw new ApiFailure(503, 'Customer photo service unavailable'); await c.organizations.requireAccess(c.token, c.organizationId, 'crm.basic', true); const photo = await c.photos.restore(c.token, c.organizationId, c.customerId, id.data.photoId); if (!photo)
    throw new ApiFailure(404, 'Customer photo not found'); return photo; }); app.post('/api/v1/organizations/:organizationId/customers/:customerId/photos/:photoId/complete', async (request) => { const c = service(request), id = z.object({ photoId: z.uuid() }).safeParse(request.params); if (!id.success)
    throw new ApiFailure(422, 'Invalid customer photo ID'); await c.organizations.requireAccess(c.token, c.organizationId, 'crm.basic', true); if (!c.photos.completeUpload)
    throw new ApiFailure(503, 'Photo upload completion unavailable'); return c.photos.completeUpload(c.token, c.organizationId, c.customerId, id.data.photoId); }); app.post('/api/v1/organizations/:organizationId/customers/:customerId/photos/upload-url', async (request, reply) => { const c = service(request), input = upload.safeParse(request.body); if (!input.success)
    throw new ApiFailure(422, 'Invalid customer photo input'); await c.organizations.requireAccess(c.token, c.organizationId, 'crm.basic', true); return reply.code(201).send(await c.photos.createUpload(c.token, c.organizationId, c.customerId, input.data)); }); app.post('/api/v1/organizations/:organizationId/customers/:customerId/photos/:photoId/download-url', async (request) => { const c = service(request), id = z.object({ photoId: z.uuid() }).safeParse(request.params); if (!id.success)
    throw new ApiFailure(422, 'Invalid customer photo ID'); await c.organizations.requireAccess(c.token, c.organizationId, 'crm.basic'); return c.photos.createDownload(c.token, c.organizationId, c.customerId, id.data.photoId); }); app.delete('/api/v1/organizations/:organizationId/customers/:customerId/photos/:photoId', async (request) => { const c = service(request), id = z.object({ photoId: z.uuid() }).safeParse(request.params); if (!id.success)
    throw new ApiFailure(422, 'Invalid customer photo ID'); await c.organizations.requireAccess(c.token, c.organizationId, 'crm.basic', true); const photo = await c.photos.archive(c.token, c.organizationId, c.customerId, id.data.photoId); if (!photo)
    throw new ApiFailure(404, 'Customer photo not found'); return photo; }); }
