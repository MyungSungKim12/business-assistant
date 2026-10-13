import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { assertOrganization, createRest } from '../../supabase/rest.js';
import { treatmentErrorCodes, withMessages, withPgErrorCodes } from './pg-errors.js';
import { eventRow, photoRow, treatmentRow, type TreatmentEvent, type TreatmentMutation, type TreatmentPhoto, type TreatmentRow, type TreatmentValues } from './schemas.js';

export const treatmentMessages = {
  404: 'Treatment not found', 403: 'Treatment write not allowed', 409: 'Record changed or transition not allowed',
  422: 'Invalid treatment values', 503: 'Treatment service unavailable',
} as const;
const unavailable = treatmentMessages[503];

const treatmentSelect = 'id,organization_id,customer_id,treatment_date,treatment_name,category,practitioner,notes,amount,next_visit_date,status,version,started_at,ended_at,consultation_goal,consultation_plan,cautions_snapshot,cautions_acknowledged_by,cautions_acknowledged_at';
const photoSelect = 'id,organization_id,customer_id,treatment_id,storage_path,thumbnail_path,phase,content_type,caption,sort_order,taken_at';
const eventSelect = 'id,actor_id,action,reason,occurred_at,before_data,after_data';

export type TreatmentGateway = ReturnType<typeof createTreatmentGateway>;

/** 시술 기록·변경 이력·사진 메타데이터. 모든 호출은 사용자 토큰으로 Supabase를 직접 부른다. */
export function createTreatmentGateway(config: ServerConfig, fetcher: typeof fetch = fetch) {
  const rest = createRest(config, withPgErrorCodes(fetcher, treatmentErrorCodes), unavailable);
  const guard = <T>(work: () => Promise<T>) => withMessages(work, treatmentMessages);
  const scope = (organizationId: string, customerId: string) => ({ organization_id: `eq.${organizationId}`, customer_id: `eq.${customerId}` });

  return {
    list: (token: string, organizationId: string, customerId: string): Promise<TreatmentRow[]> => guard(async () => assertOrganization(
      await rest.select(token, 'treatment_records', { select: treatmentSelect, ...scope(organizationId, customerId), order: 'treatment_date.desc' }, treatmentRow), organizationId, unavailable)),

    create: (token: string, organizationId: string, customerId: string, values: TreatmentValues): Promise<TreatmentRow> => guard(async () => {
      const row = await rest.insert(token, 'treatment_records', { organization_id: organizationId, customer_id: customerId, ...values }, treatmentRow);
      assertOrganization([row], organizationId, unavailable);
      return row;
    }),

    /** 낙관적 잠금·멱등 키·감사 이력을 한 트랜잭션으로 처리하는 mutate_treatment RPC. 행이 없으면 404. */
    mutate: (token: string, organizationId: string, customerId: string, treatmentId: string, mutation: TreatmentMutation): Promise<TreatmentRow> => guard(async () => {
      const rows = await rest.rpc(token, 'mutate_treatment', {
        p_organization_id: organizationId, p_customer_id: customerId, p_treatment_id: treatmentId,
        p_action: mutation.action, p_expected_version: mutation.expected_version, p_operation_id: mutation.operation_id,
        p_reason: mutation.reason, p_values: mutation.values ?? {},
      }, z.array(treatmentRow));
      assertOrganization(rows, organizationId, unavailable);
      if (!rows[0]) throw new ApiFailure(404, treatmentMessages[404]);
      return rows[0];
    }),

    events: (token: string, organizationId: string, customerId: string, treatmentId: string): Promise<TreatmentEvent[]> => guard(() => rest.select(token, 'treatment_record_events', {
      select: eventSelect, ...scope(organizationId, customerId), treatment_id: `eq.${treatmentId}`, order: 'occurred_at.desc,id.desc',
    }, eventRow)),

    listPhotos: (token: string, organizationId: string, customerId: string, treatmentId?: string): Promise<TreatmentPhoto[]> => guard(async () => assertOrganization(
      await rest.select(token, 'treatment_photos', {
        select: photoSelect, ...scope(organizationId, customerId), ...(treatmentId ? { treatment_id: `eq.${treatmentId}` } : {}), order: 'sort_order.asc,created_at.asc',
      }, photoRow), organizationId, unavailable)),

    createPhoto: (token: string, organizationId: string, customerId: string, values: Record<string, unknown>): Promise<TreatmentPhoto> => guard(async () => {
      const row = await rest.insert(token, 'treatment_photos', { organization_id: organizationId, customer_id: customerId, ...values }, photoRow);
      assertOrganization([row], organizationId, unavailable);
      return row;
    }),

    /** 구분(phase)·설명 수정. 일치하는 사진이 없으면 null(404 대응). */
    updatePhoto: (token: string, organizationId: string, customerId: string, photoId: string, patch: Record<string, unknown>): Promise<TreatmentPhoto | null> => guard(async () => {
      const row = await rest.update(token, 'treatment_photos', { select: photoSelect, id: `eq.${photoId}`, ...scope(organizationId, customerId) }, patch, photoRow);
      if (row) assertOrganization([row], organizationId, unavailable);
      return row;
    }),

    /** 지운 사진이 없으면 false(404 대응). REST 도우미는 삭제 결과 행을 돌려주지 않으므로 먼저 존재를 확인한다. */
    deletePhoto: (token: string, organizationId: string, customerId: string, photoId: string): Promise<boolean> => guard(async () => {
      const query = { id: `eq.${photoId}`, ...scope(organizationId, customerId) };
      const found = await rest.select(token, 'treatment_photos', { select: 'id', ...query }, z.object({ id: z.string() }));
      if (!found.length) return false;
      await rest.remove(token, 'treatment_photos', query);
      return true;
    }),
  };
}
