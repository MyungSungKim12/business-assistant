import { z } from 'zod';

export const userSchema = z.object({ user_id: z.uuid(), email: z.string(), display_name: z.string().nullable() });
export const sessionSchema = z.object({ access_token: z.string().min(1), refresh_token: z.string().nullable(), user: userSchema });
export const organizationSchema = z.object({ id: z.uuid(), name: z.string(), slug: z.string(), role: z.string() });
export const organizationsSchema = z.array(organizationSchema);
export const entitlementSchema = z.object({ organization_id: z.uuid(), plan_code: z.string().nullable(), features: z.array(z.string()) });
export const customerSchema = z.object({ id: z.uuid(), organization_id: z.uuid(), name: z.string(), email: z.string().nullable(), phone: z.string().nullable(), notes: z.string(), birth_date: z.string().nullable(), skin_type: z.string().nullable(), concerns: z.array(z.string()), allergies: z.string(), last_visit_date: z.string().nullable(), next_visit_date: z.string().nullable(), tags: z.array(z.string()), status: z.string() });
export const customersSchema = z.array(customerSchema);

export type AuthUser = z.infer<typeof userSchema>;
export type Session = z.infer<typeof sessionSchema>;
export type Organization = z.infer<typeof organizationSchema>;
export type Entitlement = z.infer<typeof entitlementSchema>;
export type Customer = z.infer<typeof customerSchema>;
