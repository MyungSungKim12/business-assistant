import {z} from 'zod';

export const visitSegmentInput=z.object({service_id:z.uuid(),staff_id:z.uuid(),resource_ids:z.array(z.uuid()).max(20).refine(ids=>new Set(ids).size===ids.length)}).strict();
const operation=z.object({operation_id:z.uuid()}).strict();
export const createVisitGroupInput=z.object({customer_id:z.uuid(),start_at:z.iso.datetime({offset:true}),source:z.enum(['manual','phone','walk_in','online']).default('manual'),items:z.array(visitSegmentInput).min(2).max(8),operation_id:z.uuid()}).strict();
export const replaceVisitGroupInput=z.object({expected_version:z.number().int().positive(),start_at:z.iso.datetime({offset:true}),source:z.enum(['manual','phone','walk_in','online']).default('manual'),items:z.array(visitSegmentInput).min(2).max(8),operation_id:z.uuid()}).strict();
export const cancelVisitGroupInput=operation.extend({expected_version:z.number().int().positive(),reason:z.string().trim().min(1).max(1000)});
export const transitionVisitGroupInput=operation.extend({expected_version:z.number().int().positive(),target_status:z.enum(['confirmed','checked_in','completed','no_show']),reason:z.string().trim().min(1).max(1000).nullable().optional()}).strict().superRefine((value,context)=>{if(value.target_status==='no_show'&&!value.reason)context.addIssue({code:'custom',message:'노쇼 사유를 입력해 주세요.',path:['reason']});if(value.target_status!=='no_show'&&value.reason)context.addIssue({code:'custom',message:'이 상태에는 사유를 입력할 수 없습니다.',path:['reason']});});
