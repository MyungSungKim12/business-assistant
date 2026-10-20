import { z } from 'zod';
export const visitLinkRequest = z.strictObject({
  appointment_id:z.uuid().nullable(),visit_id:z.uuid().nullable(),expected_version:z.number().int().min(1),
  operation_id:z.uuid(),reason:z.string().trim().min(1).max(2000),
});
export type VisitLinkRequest=z.infer<typeof visitLinkRequest>;
export const contextAppointment=z.object({id:z.uuid(),organization_id:z.uuid(),customer_id:z.uuid(),service_name_snapshot:z.string(),start_at:z.string(),status:z.enum(['reserved','confirmed','checked_in','completed','canceled','no_show'])});
export const contextVisit=z.object({id:z.uuid(),organization_id:z.uuid(),customer_id:z.uuid(),appointment_id:z.uuid().nullable(),opened_at:z.string(),status:z.enum(['open','checkout_ready','closed','canceled'])});
