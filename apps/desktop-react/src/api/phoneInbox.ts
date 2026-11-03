import {z} from 'zod';
export const phoneConsentSchema=z.object({enabled:z.boolean(),version:z.number().int().nonnegative(),retention_days:z.literal(30)});
export const phoneInboxRecordSchema=z.object({id:z.uuid(),organization_id:z.uuid(),recipient_id:z.uuid(),phone_e164:z.string(),occurred_at:z.string(),received_at:z.string(),expires_at:z.string(),customer_ids:z.array(z.uuid()),retained:z.literal(true),retained_until:z.string(),status:z.enum(['unconfirmed','seen','completed','callback_needed']),assignee_id:z.uuid().nullable(),version:z.number().int().positive(),callback_task_id:z.uuid().nullable()});
export const phoneInboxPageSchema=z.object({items:z.array(phoneInboxRecordSchema),cursor:z.string(),next_cursor:z.string().nullable()});
export type PhoneInboxRecord=z.infer<typeof phoneInboxRecordSchema>;
export type PhoneResponse={recipient_id:string;expected_version:number;operation_id:string;status?:PhoneInboxRecord['status'];memo?:string;customer_id?:string;assignee_id?:string|null;callback_due_at?:string};
export type PhoneInboxQuery={after?:string;limit?:number;status?:PhoneInboxRecord['status'];customer_id?:string;from?:string;to?:string};
