import { z } from 'zod';
const scope={id:z.string(),organization_id:z.string(),customer_id:z.string()};
export const treatmentContextSchema=z.object({
  appointments:z.array(z.object({...scope,service_name_snapshot:z.string(),start_at:z.string(),status:z.enum(['reserved','confirmed','checked_in','completed','canceled','no_show'])})),
  visits:z.array(z.object({...scope,appointment_id:z.string().nullable(),opened_at:z.string(),status:z.enum(['open','checkout_ready','closed','canceled'])})),
});
export type TreatmentContext=z.infer<typeof treatmentContextSchema>;
export type VisitLinkInput={appointment_id:string|null;visit_id:string|null;expected_version:number;operation_id:string;reason:string};
