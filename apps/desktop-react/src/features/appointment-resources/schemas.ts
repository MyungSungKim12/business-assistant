import { z } from 'zod';

export const resourceKindSchema = z.enum(['room', 'equipment']);
export type ResourceKind = z.infer<typeof resourceKindSchema>;

export const resourceSchema = z.object({
  id: z.string(), organization_id: z.string(), name: z.string(), kind: resourceKindSchema, is_active: z.boolean(), version: z.number(),
});
export const resourcesSchema = z.array(resourceSchema);
export type AppointmentResource = z.infer<typeof resourceSchema>;

export const requirementSchema = z.object({ kind: resourceKindSchema, quantity: z.number().int().min(1).max(10) });
export const requirementsSchema = z.array(requirementSchema);
export type ResourceRequirement = z.infer<typeof requirementSchema>;

/** 서비스별 필수 자원 기준과 낙관적 잠금 버전(Node 보조 경로 resource-setup). */
export const resourceSetupSchema = z.object({ service_id: z.string(), resource_version: z.number(), requirements: requirementsSchema });
export const requirementsSavedSchema = z.object({ service_id: z.string(), resource_version: z.number(), requirements: z.array(z.unknown()) });
export const consumableSchema = z.object({ product_id: z.string(), quantity: z.number().int().min(1).max(1_000_000) });
export const consumablesSchema = z.array(consumableSchema);
/** 서비스별 담당 가능 직원(SVC-11). 지정이 없는 서비스는 항목이 없고, 그 서비스는 모든 직원이 가능하다. */
export const serviceStaffListSchema = z.array(z.object({ service_id: z.string(), staff_id: z.string() }));
export const serviceStaffIdsSchema = z.object({ staff_ids: z.array(z.string()) });

export const staffSchema = z.object({ id: z.string(), organization_id: z.string(), name: z.string(), is_active: z.boolean(), profile_version: z.number().int().positive().optional(), schedule_version: z.number().default(1) });
export const staffListSchema = z.array(staffSchema);
export type AppointmentStaffRow = z.infer<typeof staffSchema>;

export const serviceSchema = z.object({
  id: z.string(), organization_id: z.string(), name: z.string(), duration_minutes: z.number(), buffer_minutes: z.number(),
  is_active: z.boolean(), resource_version: z.number().default(1),
  /** 서비스 가격(원)·카테고리·편집 버전. 확장 목록(appointment-service-details)에만 있고 구버전 서버 응답에는 없다. */
  price_krw: z.number().default(0), category: z.string().default(''), service_version: z.number().default(1),
});
export const serviceListSchema = z.array(serviceSchema);
export type AppointmentServiceRow = z.infer<typeof serviceSchema>;

export const workingHourSchema = z.object({ id: z.string(), staff_id: z.string(), weekday: z.number().int().min(1).max(7), start_time: z.string(), end_time: z.string(), timezone_name: z.string() });
export const timeOffSchema = z.object({
  id: z.string(), staff_id: z.string(), start_at: z.string(), end_at: z.string(), reason: z.string(), status: z.enum(['active', 'canceled']), version: z.number(),
});
export const availabilitySchema = z.object({ staff_id: z.string(), schedule_version: z.number(), hours: z.array(workingHourSchema), time_off: z.array(timeOffSchema) });
export const workingHoursSavedSchema = z.object({ staff_id: z.string(), schedule_version: z.number(), timezone_name: z.string(), hours: z.array(workingHourSchema) });
export type StaffAvailability = z.infer<typeof availabilitySchema>;
export type TimeOff = z.infer<typeof timeOffSchema>;

export const kindLabel: Record<ResourceKind, string> = { room: '공간', equipment: '장비' };
