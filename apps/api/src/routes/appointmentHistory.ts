import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { ApiFailure } from '../errors.js';
import { bearerToken } from './organizations.js';

const status=z.enum(['reserved','confirmed','checked_in','completed','canceled','no_show']);
export const appointmentStatusEventSchema=z.object({id:z.uuid(),organization_id:z.uuid(),appointment_id:z.uuid(),appointment_version:z.number().int().min(2),previous_status:status,next_status:status,reason:z.string().max(1000).nullable(),actor_id:z.uuid(),occurred_at:z.iso.datetime({offset:true})});
export type AppointmentStatusEvent=z.infer<typeof appointmentStatusEventSchema>;
export type HistoryGateway={history?:(token:string,organizationId:string,appointmentId:string)=>Promise<AppointmentStatusEvent[]>};
export function registerAppointmentHistoryRoutes(app:FastifyInstance,organizations:{requireAccess:(token:string,id:string,feature:string,write?:boolean)=>Promise<string>}|undefined,gateway:HistoryGateway|undefined){
 app.get('/api/v1/organizations/:organizationId/appointments/:appointmentId/status-events',async request=>{
  const token=bearerToken(request),parsed=z.object({organizationId:z.uuid(),appointmentId:z.uuid()}).safeParse(request.params);
  if(!parsed.success)throw new ApiFailure(422,'Invalid appointment ID');
  if(!organizations||!gateway?.history)throw new ApiFailure(503,'Appointment history unavailable');
  const {organizationId,appointmentId}=parsed.data;
  await organizations.requireAccess(token,organizationId,'task.basic');
  return gateway.history(token,organizationId,appointmentId);
 });
}
