import {z} from 'zod';
import type {ServerConfig} from '../../config.js';
import {ApiFailure} from '../../errors.js';
import {createRest} from '../../supabase/rest.js';
import {withPgErrorMap} from '../catalog/pgErrors.js';
import {appointmentSchema} from '../appointment-resources/gateway.js';
import type {createVisitGroupInput,replaceVisitGroupInput,transitionVisitGroupInput} from './schemas.js';

const itemAppointment=appointmentSchema.extend({visit_group_id:z.uuid(),visit_order:z.number().int().min(1).max(8),is_current:z.boolean()});
const createdResult=z.object({visit_group_id:z.uuid(),organization_id:z.uuid(),customer_id:z.uuid(),version:z.number().int().positive(),status:z.literal('active'),created:z.array(itemAppointment).min(2).max(8),replayed:z.boolean()});
const replacedResult=z.object({id:z.uuid(),organization_id:z.uuid(),customer_id:z.uuid(),version:z.number().int().positive(),status:z.literal('active'),replaced:z.array(itemAppointment).min(2).max(8),created:z.array(itemAppointment).min(2).max(8),replayed:z.boolean()});
const canceledResult=z.object({id:z.uuid(),organization_id:z.uuid(),customer_id:z.uuid(),version:z.number().int().positive(),status:z.literal('canceled'),canceled:z.array(itemAppointment).min(2).max(8),replayed:z.boolean()});
const transitionedResult=z.object({id:z.uuid(),organization_id:z.uuid(),customer_id:z.uuid(),version:z.number().int().positive(),status:z.enum(['active','completed','no_show']),updated:z.array(appointmentSchema).min(2).max(8),replayed:z.boolean()});
export type VisitGroupGateway=ReturnType<typeof createAppointmentVisitGroupGateway>;
export function createAppointmentVisitGroupGateway(config:ServerConfig,fetcher:typeof fetch=fetch){
 const rest=createRest(config,withPgErrorMap(fetcher),'Appointment service unavailable');
 async function scoped<T extends {organization_id:string}>(promise:Promise<T>,organizationId:string):Promise<T>{const value=await promise;if(value.organization_id!==organizationId)throw new ApiFailure(503,'Appointment service unavailable');return value;}
 return {
  async create(token:string,organizationId:string,input:z.infer<typeof createVisitGroupInput>){
   const value=await rest.rpc(token,'create_appointment_visit_group',{p_organization_id:organizationId,p_customer_id:input.customer_id,p_start_at:input.start_at,p_source:input.source,p_items:input.items,p_operation_id:input.operation_id},createdResult);
   const result=await scoped(Promise.resolve(value),organizationId);if(result.created.some(row=>row.organization_id!==organizationId||row.visit_group_id!==result.visit_group_id||!row.is_current))throw new ApiFailure(503,'Appointment service unavailable');return result;
  },
  async replace(token:string,organizationId:string,groupId:string,input:z.infer<typeof replaceVisitGroupInput>){
   const value=await rest.rpc(token,'replace_appointment_visit_group',{p_organization_id:organizationId,p_visit_group_id:groupId,p_expected_version:input.expected_version,p_start_at:input.start_at,p_source:input.source,p_items:input.items,p_operation_id:input.operation_id},replacedResult);
   const result=await scoped(Promise.resolve(value),organizationId);if(result.id!==groupId||result.created.some(row=>row.organization_id!==organizationId||row.visit_group_id!==groupId||!row.is_current)||result.replaced.some(row=>row.is_current||row.status!=='canceled'))throw new ApiFailure(503,'Appointment service unavailable');return{visit_group_id:result.id,organization_id:result.organization_id,customer_id:result.customer_id,version:result.version,status:result.status,created:result.created,replayed:result.replayed};
  },
  async cancel(token:string,organizationId:string,groupId:string,input:{expected_version:number;reason:string;operation_id:string}){
   const value=await rest.rpc(token,'cancel_appointment_visit_group',{p_organization_id:organizationId,p_visit_group_id:groupId,p_expected_version:input.expected_version,p_reason:input.reason,p_operation_id:input.operation_id},canceledResult);
   const result=await scoped(Promise.resolve(value),organizationId);if(result.id!==groupId||result.canceled.some(row=>row.organization_id!==organizationId||row.visit_group_id!==groupId||row.status!=='canceled'||!row.is_current))throw new ApiFailure(503,'Appointment service unavailable');return{visit_group_id:result.id,organization_id:result.organization_id,customer_id:result.customer_id,version:result.version,status:result.status,canceled:result.canceled,replayed:result.replayed};
  },
  async transition(token:string,organizationId:string,groupId:string,input:z.infer<typeof transitionVisitGroupInput>){
   const value=await rest.rpc(token,'transition_appointment_visit_group',{p_organization_id:organizationId,p_visit_group_id:groupId,p_expected_version:input.expected_version,p_target_status:input.target_status,p_reason:input.reason??null,p_operation_id:input.operation_id},transitionedResult);
   const result=await scoped(Promise.resolve(value),organizationId);if(result.id!==groupId||result.updated.some(row=>row.organization_id!==organizationId||row.visit_group_id!==groupId||!row.is_current||row.status!==input.target_status))throw new ApiFailure(503,'Appointment service unavailable');return{visit_group_id:result.id,organization_id:result.organization_id,customer_id:result.customer_id,version:result.version,status:result.status,updated:result.updated,replayed:result.replayed};
  },
 };
}
