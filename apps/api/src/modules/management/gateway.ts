import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { ApiFailure } from '../../errors.js';
import { createRest } from '../../supabase/rest.js';
import { withPgErrorMap } from '../catalog/pgErrors.js';

const UNAVAILABLE = 'Management service unavailable';
/** 금액은 문자열로 돌려준다(Python Decimal 직렬화와 같다). 숫자·문자열 둘 다 받고 유한한 십진수만 허용한다. */
const decimal = z.union([z.string(), z.number()])
  .refine((value) => /^-?\d+(\.\d+)?$/.test(String(value).trim()), 'Invalid money')
  .transform((value) => String(value).trim());
const nonNegativeDecimal = decimal.refine((value) => !value.startsWith('-'), 'Must not be negative');

export const managementPreviewSchema = z.object({
  organization_id: z.uuid(),
  from_date: z.iso.date(),
  to_date: z.iso.date(),
  recorded_income: decimal,
  recorded_expense: decimal,
  recorded_net: decimal,
  transaction_count: z.number().int().min(0),
  visit_receipts: decimal,
  visit_refunds: decimal,
  staff_sales_basis: z.array(z.object({
    staff_id: z.uuid().nullable(),
    staff_name_snapshot: z.string(),
    line_count: z.number().int().min(0),
    gross_line_total: nonNegativeDecimal,
  })),
  is_final_profit: z.boolean(),
  excluded_costs: z.array(z.string()),
  staff_basis_is_commission: z.boolean(),
});
export type ManagementPreview = z.infer<typeof managementPreviewSchema>;

export function createManagementGateway(config: ServerConfig, fetcher: typeof fetch = fetch) {
  const rest = createRest(config, withPgErrorMap(fetcher), UNAVAILABLE);
  return {
    /** 확정 손익이 아닌 읽기 전용 미리보기. 확정(최종 이익·수당 확정) 표시가 오면 닫힌 실패로 처리한다. */
    async getPreview(token: string, organizationId: string, fromDate: string, toDate: string): Promise<ManagementPreview> {
      const result = await rest.rpc(token, 'get_management_preview', { p_organization_id: organizationId, p_from_date: fromDate, p_to_date: toDate }, managementPreviewSchema);
      if (result.organization_id !== organizationId || result.from_date !== fromDate || result.to_date !== toDate || result.is_final_profit || result.staff_basis_is_commission) {
        throw new ApiFailure(503, UNAVAILABLE);
      }
      return result;
    },
  };
}
export type ManagementGateway = ReturnType<typeof createManagementGateway>;
