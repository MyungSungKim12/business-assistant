import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import type { SaleDraftGateway } from './sale-drafts.js';
import type { TreatmentGateway } from './gateway.js';
import { treatmentMessages } from './gateway.js';
import { id, mutationRequest, photoPatch, photoRequest, saleCreateRequest, salePreviewRequest, treatmentRequest, treatmentUpdateRequest, type TreatmentMutation } from './schemas.js';

export type OrgAccess = Pick<{ requireAccess(token: string, id: string, feature: string, write?: boolean): Promise<string> }, 'requireAccess'>;

const base = '/api/v1/organizations/:organizationId';
const customerBase = `${base}/customers/:customerId`;
const scoped = `${customerBase}/treatments/:treatmentId`;
const saleFeatures = ['crm.basic', 'finance.basic', 'document.template'] as const;

function parse<T>(schema: z.ZodType<T>, value: unknown, message: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiFailure(422, message);
  return result.data;
}
const orgParams = z.object({ organizationId: id });
const customerParams = orgParams.extend({ customerId: id });
const treatmentParams = customerParams.extend({ treatmentId: id });
const serviceLinkRequest = z.strictObject({ service_id: id.nullable(), expected_version: z.number().int().min(1), operation_id: id });
const photoParams = customerParams.extend({ photoId: id });

/** 시술 기록·상담·상태 전이·변경 이력·사진 메타데이터 라우트(Python api/treatments.py). 쓰기는 owner/admin만. */
export function registerTreatmentRoutes(app: FastifyInstance, organizations: OrgAccess | undefined, gateway: TreatmentGateway): void {
  function access(request: FastifyRequest) {
    const token = bearerToken(request);
    if (!organizations) throw new ApiFailure(503, treatmentMessages[503]);
    return { token, organizations };
  }

  app.get(`${customerBase}/treatments`, async (request) => {
    const { token, organizations: org } = access(request);
    const params = parse(customerParams, request.params, 'Invalid treatment request');
    await org.requireAccess(token, params.organizationId, 'crm.basic');
    return gateway.list(token, params.organizationId, params.customerId);
  });

  app.post(`${customerBase}/treatments`, async (request, reply) => {
    const { token, organizations: org } = access(request);
    const params = parse(customerParams, request.params, 'Invalid treatment request');
    const values = parse(treatmentRequest, request.body, 'Invalid treatment values');
    await org.requireAccess(token, params.organizationId, 'crm.basic', true);
    reply.code(201);
    return gateway.create(token, params.organizationId, params.customerId, values);
  });

  // 옛 PATCH 소비자 호환: expected_version이 필수이고, 내부적으로 'edit' 변이로 처리한다.
  app.patch(scoped, async (request) => {
    const { token, organizations: org } = access(request);
    const params = parse(treatmentParams, request.params, 'Invalid treatment request');
    const { expected_version, operation_id, ...values } = parse(treatmentUpdateRequest, request.body, 'Invalid treatment values');
    await org.requireAccess(token, params.organizationId, 'crm.basic', true);
    if (expected_version === undefined) throw new ApiFailure(409, 'Refresh record and provide expected_version');
    const mutation: TreatmentMutation = { action: 'edit', expected_version, operation_id: operation_id ?? crypto.randomUUID(), reason: '', values };
    return gateway.mutate(token, params.organizationId, params.customerId, params.treatmentId, mutation);
  });

  app.post(`${scoped}/mutations`, async (request) => {
    const { token, organizations: org } = access(request);
    const params = parse(treatmentParams, request.params, 'Invalid treatment request');
    const mutation = parse(mutationRequest, request.body, 'Invalid treatment values');
    await org.requireAccess(token, params.organizationId, 'crm.basic', true);
    return gateway.mutate(token, params.organizationId, params.customerId, params.treatmentId, mutation);
  });

  app.put(`${scoped}/service`, async (request) => {
    const { token, organizations: org } = access(request);
    const params = parse(treatmentParams, request.params, 'Invalid treatment request');
    const body = parse(serviceLinkRequest, request.body, 'Invalid treatment service');
    await org.requireAccess(token, params.organizationId, 'crm.basic', true);
    return gateway.setService(token, params.organizationId, params.customerId, params.treatmentId, body.service_id, body.expected_version, body.operation_id);
  });

  app.get(`${scoped}/events`, async (request) => {
    const { token, organizations: org } = access(request);
    const params = parse(treatmentParams, request.params, 'Invalid treatment request');
    await org.requireAccess(token, params.organizationId, 'crm.basic');
    return gateway.events(token, params.organizationId, params.customerId, params.treatmentId);
  });

  app.get(`${customerBase}/treatment-photos`, async (request) => {
    const { token, organizations: org } = access(request);
    const params = parse(customerParams, request.params, 'Invalid treatment request');
    const query = parse(z.object({ treatment_id: id.optional() }), request.query, 'Invalid treatment request');
    await org.requireAccess(token, params.organizationId, 'crm.basic');
    return gateway.listPhotos(token, params.organizationId, params.customerId, query.treatment_id);
  });

  app.post(`${customerBase}/treatment-photos`, async (request, reply) => {
    const { token, organizations: org } = access(request);
    const params = parse(customerParams, request.params, 'Invalid treatment request');
    const values = parse(photoRequest, request.body, 'Invalid treatment values');
    await org.requireAccess(token, params.organizationId, 'crm.basic', true);
    // 다른 조직의 저장 경로를 연결하지 못하게 한다(저장 경로는 항상 조직 ID로 시작한다).
    if (!values.storage_path.startsWith(`${params.organizationId}/`)) throw new ApiFailure(422, 'Invalid treatment values');
    reply.code(201);
    return gateway.createPhoto(token, params.organizationId, params.customerId, values);
  });

  app.patch(`${customerBase}/treatment-photos/:photoId`, async (request) => {
    const { token, organizations: org } = access(request);
    const params = parse(photoParams, request.params, 'Invalid treatment request');
    const patch = parse(photoPatch, request.body, 'Invalid treatment values');
    await org.requireAccess(token, params.organizationId, 'crm.basic', true);
    const photo = await gateway.updatePhoto(token, params.organizationId, params.customerId, params.photoId, patch);
    if (!photo) throw new ApiFailure(404, 'Treatment photo not found');
    return photo;
  });

  app.delete(`${customerBase}/treatment-photos/:photoId`, async (request, reply) => {
    const { token, organizations: org } = access(request);
    const params = parse(photoParams, request.params, 'Invalid treatment request');
    await org.requireAccess(token, params.organizationId, 'crm.basic', true);
    if (!await gateway.deletePhoto(token, params.organizationId, params.customerId, params.photoId)) throw new ApiFailure(404, 'Treatment photo not found');
    return reply.code(204).send();
  });
}

/** 시술 결제 초안 라우트(Python api/treatment_sale_drafts.py). 세 기능이 모두 필요하고, 전달(생성)만 owner/admin. */
export function registerSaleDraftRoutes(app: FastifyInstance, organizations: OrgAccess | undefined, gateway: SaleDraftGateway): void {
  async function access(request: FastifyRequest, write: boolean) {
    const token = bearerToken(request);
    if (!organizations) throw new ApiFailure(503, 'Sale draft service unavailable');
    return { token, organizations, authorize: async (organizationId: string) => {
      for (const feature of saleFeatures) await organizations.requireAccess(token, organizationId, feature, write);
    } };
  }

  app.post(`${scoped}/sale-draft/preview`, async (request) => {
    const { token, authorize } = await access(request, false);
    const params = parse(treatmentParams, request.params, 'Invalid sale draft request');
    const body = parse(salePreviewRequest, request.body, 'Invalid sale draft request');
    await authorize(params.organizationId);
    return gateway.preview(token, params.organizationId, params.customerId, params.treatmentId, body.values);
  });

  app.post(`${scoped}/sale-draft`, async (request, reply) => {
    const { token, authorize } = await access(request, true);
    const params = parse(treatmentParams, request.params, 'Invalid sale draft request');
    const body = parse(saleCreateRequest, request.body, 'Invalid sale draft request');
    await authorize(params.organizationId);
    reply.code(201);
    return gateway.create(token, params.organizationId, params.customerId, params.treatmentId, body.operation_id, body.expected_preview, body.confirmed);
  });

  app.get(`${scoped}/sale-draft`, async (request) => {
    const { token, authorize } = await access(request, false);
    const params = parse(treatmentParams, request.params, 'Invalid sale draft request');
    await authorize(params.organizationId);
    return gateway.listForTreatment(token, params.organizationId, params.customerId, params.treatmentId);
  });

  app.get(`${base}/treatment-sale-drafts`, async (request) => {
    const { token, authorize } = await access(request, false);
    const params = parse(orgParams, request.params, 'Invalid sale draft request');
    await authorize(params.organizationId);
    return gateway.listAll(token, params.organizationId);
  });
}
