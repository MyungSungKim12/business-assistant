import { z } from 'zod';

export const userSchema = z.object({ user_id: z.uuid(), email: z.string(), display_name: z.string().nullable() });
export const sessionSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().nullable(), user: userSchema });
export const organizationSchema = z.object({ id: z.uuid(), name: z.string(), slug: z.string(), role: z.string() });
export const organizationsSchema = z.array(organizationSchema);
export const entitlementSchema = z.object({ organization_id: z.uuid(), plan_code: z.string().nullable(), features: z.array(z.string()) });
export const customerSchema = z.object({ id: z.uuid(), organization_id: z.uuid(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), notes: z.string(), birth_date: z.string().nullable(), skin_type: z.string().nullable(), concerns: z.array(z.string()), allergies: z.string(), last_visit_date: z.string().nullable(), next_visit_date: z.string().nullable(), tags: z.array(z.string()), status: z.string(), created_at: z.string().optional() });
export const customersSchema = z.array(customerSchema);
export const customerActivitySchema = z.object({ id:z.uuid(), organization_id:z.uuid(), customer_id:z.uuid(), activity_type:z.string(), title:z.string(), description:z.string(), occurred_at:z.string() });
export const customerActivitiesSchema = z.array(customerActivitySchema);
export const customerPhotoSchema=z.object({id:z.uuid(),organization_id:z.uuid(),customer_id:z.uuid(),original_name:z.string(),storage_path:z.string(),content_type:z.string(),size_bytes:z.number(),caption:z.string(),created_at:z.string()});
export const taskSchema=z.object({id:z.uuid(),organization_id:z.uuid(),created_by:z.uuid(),title:z.string(),description:z.string(),due_at:z.string().nullable(),status:z.string(),priority:z.string(),created_at:z.string().optional()});export const tasksSchema=z.array(taskSchema);
export const customerPhotosSchema=z.array(customerPhotoSchema); export const signedPhotoSchema=z.object({photo:customerPhotoSchema,signed_url:z.string().url(),expires_in:z.number()});
export const appointmentSchema=z.object({id:z.uuid(),organization_id:z.uuid(),customer_id:z.uuid(),staff_id:z.uuid(),service_id:z.uuid(),service_name_snapshot:z.string(),duration_minutes:z.number(),buffer_minutes:z.number(),start_at:z.string(),end_at:z.string(),status:z.string(),source:z.string(),cancellation_reason:z.string().nullable(),version:z.number(),resource_ids:z.array(z.uuid()).default([])});export const appointmentsSchema=z.array(appointmentSchema);
export const appointmentStaffSchema=z.object({id:z.uuid(),organization_id:z.uuid(),name:z.string(),is_active:z.boolean(),schedule_version:z.number()});export const appointmentStaffListSchema=z.array(appointmentStaffSchema);export const appointmentServiceSchema=z.object({id:z.uuid(),organization_id:z.uuid(),name:z.string(),duration_minutes:z.number(),buffer_minutes:z.number(),is_active:z.boolean(),resource_version:z.number().default(1)});export const appointmentServiceListSchema=z.array(appointmentServiceSchema);
export const operationRecordSchema=z.record(z.string(),z.unknown());export const operationRecordsSchema=z.array(operationRecordSchema);
export const auditEventSchema=z.object({id:z.uuid(),organization_id:z.uuid().nullable(),actor_id:z.uuid().nullable(),action:z.string(),target_type:z.string(),target_id:z.string().nullable(),metadata:z.record(z.string(),z.unknown()),request_id:z.string().nullable(),ip:z.string().nullable(),source:z.string(),created_at:z.iso.datetime({offset:true})});
export const auditEventsPageSchema=z.object({items:z.array(auditEventSchema),next_cursor:z.string().nullable()});

export type AuthUser = z.infer<typeof userSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type Entitlement = z.infer<typeof entitlementSchema>;
export type Customer = z.infer<typeof customerSchema>;
export type CustomerActivity = z.infer<typeof customerActivitySchema>;
export type CustomerPhoto=z.infer<typeof customerPhotoSchema>; export type SignedPhoto=z.infer<typeof signedPhotoSchema>;
export type Task=z.infer<typeof taskSchema>;
export type Appointment=z.infer<typeof appointmentSchema>;
export type AppointmentStaff=z.infer<typeof appointmentStaffSchema>;export type AppointmentService=z.infer<typeof appointmentServiceSchema>;
export type OperationRecord=z.infer<typeof operationRecordsSchema>[number];
export type AuditEvent=z.infer<typeof auditEventSchema>;
export type AuditEventsPage=z.infer<typeof auditEventsPageSchema>;

export const signUpResultSchema = z.union([sessionSchema.extend({ email_confirmation_required: z.literal(false) }), z.object({ email_confirmation_required: z.literal(true) })]);
