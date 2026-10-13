import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { assertOrganization, createRest } from '../../supabase/rest.js';
import { saleDraftErrorCodes, withMessages, withPgErrorCodes } from './pg-errors.js';
import { saleDraftRow, salePreview, type SaleDraft, type SalePreview } from './schemas.js';

export const saleDraftMessages = {
  409: 'Preview changed or draft already exists; review again', 404: 'Customer, treatment or document not found',
  403: 'Sale draft access permission required', 422: 'Invalid sale draft request', 503: 'Sale draft service unavailable',
} as const;
const unavailable = saleDraftMessages[503];

// 재시도 지문(request_fingerprint)과 operation_id 컬럼은 읽지 않는다.
const draftSelect = 'id,organization_id,customer_id,treatment_id,status,description,amount,source_snapshot,created_by,created_at';
const PAGE = 500;
const MAX_PAGES = 1_000;

export type SaleDraftGateway = ReturnType<typeof createSaleDraftGateway>;

/** 시술 결제 초안: 미리보기·불변 전달(create RPC)·조회. 결제·매출 부수효과는 없다. */
export function createSaleDraftGateway(config: ServerConfig, fetcher: typeof fetch = fetch) {
  const rest = createRest(config, withPgErrorCodes(fetcher, saleDraftErrorCodes), unavailable);
  const guard = <T>(work: () => Promise<T>) => withMessages(work, saleDraftMessages);
  const fail = () => new ApiFailure(503, unavailable);

  return {
    preview: (token: string, organizationId: string, customerId: string, treatmentId: string, values: unknown): Promise<SalePreview> => guard(() => rest.rpc(token, 'preview_treatment_sale_draft', {
      p_organization_id: organizationId, p_customer_id: customerId, p_treatment_id: treatmentId, p_values: values,
    }, salePreview)),

    create: (token: string, organizationId: string, customerId: string, treatmentId: string, operationId: string, expectedPreview: SalePreview, confirmed: boolean): Promise<SaleDraft> => guard(async () => {
      const rows = await rest.rpc(token, 'create_treatment_sale_draft', {
        p_organization_id: organizationId, p_customer_id: customerId, p_treatment_id: treatmentId,
        p_operation_id: operationId, p_expected_preview: expectedPreview, p_confirmed: confirmed,
      }, z.array(saleDraftRow));
      if (rows.length !== 1) throw fail();
      assertOrganization(rows, organizationId, unavailable);
      return rows[0];
    }),

    /** 시술 한 건의 초안(최대 1건). 부모 시술이 이 고객·조직의 것이 아니면 404. */
    listForTreatment: (token: string, organizationId: string, customerId: string, treatmentId: string): Promise<SaleDraft[]> => guard(async () => {
      const parent = await rest.select(token, 'treatment_records', {
        select: 'id', organization_id: `eq.${organizationId}`, customer_id: `eq.${customerId}`, id: `eq.${treatmentId}`,
      }, z.object({ id: z.string() }));
      if (!parent.length) throw new ApiFailure(404, saleDraftMessages[404]);
      if (parent.length !== 1 || parent[0].id !== treatmentId) throw fail();
      const rows = assertOrganization(await rest.select(token, 'treatment_sale_drafts', {
        select: draftSelect, organization_id: `eq.${organizationId}`, status: 'eq.draft', order: 'created_at.desc,id.desc',
        customer_id: `eq.${customerId}`, treatment_id: `eq.${treatmentId}`,
      }, saleDraftRow), organizationId, unavailable);
      if (rows.length > 1) throw fail();
      return rows;
    }),

    /** 조직의 미수납 초안 전체(수납함). 공급자 행 제한이 요청한 페이지보다 작아도 빈 페이지까지 이어서 읽는다. */
    listAll: (token: string, organizationId: string): Promise<SaleDraft[]> => guard(async () => {
      const rows: SaleDraft[] = [];
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const chunk = assertOrganization(await rest.select(token, 'treatment_sale_drafts', {
          select: draftSelect, organization_id: `eq.${organizationId}`, status: 'eq.draft', order: 'created_at.desc,id.desc',
          limit: String(PAGE), offset: String(rows.length),
        }, saleDraftRow), organizationId, unavailable);
        if (!chunk.length) return rows;
        const seen = new Set(rows.map((row) => row.id));
        if (chunk.some((row) => seen.has(row.id))) throw fail();
        rows.push(...chunk);
      }
      throw fail();
    }),
  };
}
