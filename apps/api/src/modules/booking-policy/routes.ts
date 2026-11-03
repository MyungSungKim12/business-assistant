import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ApiFailure } from '../../errors.js';
import { bearerToken } from '../../routes/organizations.js';
import type { OrgAccess } from '../catalog/routes.js';
import type { BookingPolicyGateway } from './gateway.js';
import { bookingPolicySave } from './schemas.js';
export function registerBookingPolicyRoutes(app:FastifyInstance,organizations:OrgAccess|undefined,gateway:BookingPolicyGateway){
 for(const method of ['GET','PUT'] as const)app.route({method,url:'/api/v1/organizations/:organizationId/booking-policy',handler:async request=>{
  const token=bearerToken(request),params=z.object({organizationId:z.uuid()}).safeParse(request.params);
  if(!params.success)throw new ApiFailure(422,'Invalid request path');
  if(!organizations)throw new ApiFailure(503,'Booking policy unavailable');
  await organizations.requireAccess(token,params.data.organizationId,'task.basic',method==='PUT');
  if(method==='GET')return gateway.getBookingPolicy(token,params.data.organizationId);
  const input=bookingPolicySave.safeParse(request.body);if(!input.success)throw new ApiFailure(422,'Invalid booking policy');
  return gateway.saveBookingPolicy(token,params.data.organizationId,input.data);
 }});
}
