import { z } from 'zod';

export const userSchema = z.object({ user_id: z.uuid(), email: z.string(), display_name: z.string().nullable() });
export const sessionSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().nullable(), user: userSchema });
export const organizationSchema = z.object({ id: z.uuid(), name: z.string(), slug: z.string(), role: z.string() });
export const organizationsSchema = z.array(organizationSchema);
export const entitlementSchema = z.object({ organization_id: z.uuid(), plan_code: z.string().nullable(), features: z.array(z.string()) });
export const customerSchema = z.object({ id: z.uuid(), organization_id: z.uuid(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), notes: z.string(), birth_date: z.string().nullable(), skin_type: z.string().nullable(), concerns: z.array(z.string()), allergies: z.string(), last_visit_date: z.string().nullable(), next_visit_date: z.string().nullable(), tags: z.array(z.string()), status: z.string() });
export const customersSchema = z.array(customerSchema);
export const customerActivitySchema = z.object({ id:z.uuid(), organization_id:z.uuid(), customer_id:z.uuid(), activity_type:z.string(), title:z.string(), description:z.string(), occurred_at:z.string() });
export const customerActivitiesSchema = z.array(customerActivitySchema);
export const customerPhotoSchema=z.object({id:z.uuid(),organization_id:z.uuid(),customer_id:z.uuid(),original_name:z.string(),storage_path:z.string(),content_type:z.string(),size_bytes:z.number(),caption:z.string(),created_at:z.string()});
export const taskSchema=z.object({id:z.uuid(),organization_id:z.uuid(),created_by:z.uuid(),title:z.string(),description:z.string(),due_at:z.string().nullable(),status:z.string(),priority:z.string()});export const tasksSchema=z.array(taskSchema);
export const customerPhotosSchema=z.array(customerPhotoSchema); export const signedPhotoSchema=z.object({photo:customerPhotoSchema,signed_url:z.string().url(),expires_in:z.number()});

export type AuthUser = z.infer<typeof userSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type Entitlement = z.infer<typeof entitlementSchema>;
export type Customer = z.infer<typeof customerSchema>;
export type CustomerActivity = z.infer<typeof customerActivitySchema>;
export type CustomerPhoto=z.infer<typeof customerPhotoSchema>; export type SignedPhoto=z.infer<typeof signedPhotoSchema>;
export type Task=z.infer<typeof taskSchema>;
