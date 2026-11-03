import { z } from 'zod';
import { callerProfileSchema } from './schemas';

import type { Platform } from '../platform/types';
import { ApiError, apiError } from './errors';
import { auditEventsPageSchema, customerRetentionPolicyResponseSchema, customerRetentionPolicySchema, customerRetentionStatusSchema, phoneDirectoryPageSchema, phoneIdentificationSchema, incomingCallsPageSchema } from './schemas';
import {phoneConsentSchema,phoneInboxPageSchema,phoneInboxRecordSchema,type PhoneResponse,type PhoneInboxQuery} from './phoneInbox';
import { appointmentBranchesSchema } from './schemas';
import { organizationSchema, signUpResultSchema, appointmentSchema, appointmentsSchema, appointmentStaffListSchema, appointmentServiceListSchema, operationRecordSchema, operationRecordsSchema, customerActivitySchema, customerActivitiesSchema, customerPhotoSchema, customerPhotosSchema, photoUploadStatusSchema, customerSchema, customersSchema, entitlementSchema, organizationsSchema, sessionSchema, signedPhotoSchema, trashedPhotosSchema, taskPeopleSchema, taskSchema, tasksSchema, type Customer, type CustomerActivity, type CustomerPhoto, type TrashedPhoto, type Entitlement, type Organization, type Session, type SignedPhoto, type Task, type Appointment, type AppointmentStaff, type AppointmentService, type OperationRecord } from './schemas';
import type { HttpRequest, HttpResponse } from './transport';

export class ApiClient {
  async sendAccountEmail(email:string,type:'recovery'|'signup'):Promise<void>{
    const response=await this.platform.request({method:'POST',path:'/auth/email',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,type})});this.parse(z.object({message:z.string()}),response);
  }
  listAccountSessions(cursor?:string){return this.call('GET',`/auth/sessions${cursor?'?cursor='+encodeURIComponent(cursor):''}`,z.object({current_session_id:z.string().uuid(),items:z.array(z.object({session_id:z.string().uuid(),created_at:z.string(),last_active_at:z.string().nullable(),user_agent:z.string().nullable(),is_current:z.boolean()})),total:z.number(),next_cursor:z.string().uuid().nullable()}));}
  async revokeAccountSessions(sessionId:string|null){
    const result=await this.call('POST','/auth/sessions/revoke',z.object({current_revoked:z.boolean()}),{session_id:sessionId});
    if(result.current_revoked){const generation=this.beginSessionChange();await this.persistToken(generation,null);}return result;
  }
  private accessToken: string | null = null;
  private refreshInFlight: Promise<Session> | null = null;
  /** Invalidate every response/retry belonging to a previous login intent. */
  private sessionGeneration = 0;
  /** Native keyring calls are asynchronous: a late save must finish before logout clears it. */
  private tokenWriteQueue: Promise<void> = Promise.resolve();
  /** 플랫폼 관리자 여부 확인 결과(세션 동안 유지). 실패는 저장하지 않아 다음에 다시 시도한다. */
  private platformAdmin: Promise<boolean> | null = null;

  constructor(private readonly platform: Platform) {}

  async login(email: string, password: string): Promise<Session> {
    const generation = this.beginSessionChange();
    await this.persistToken(generation, null);
    const response = await this.sessionResponse({ method: 'POST', path: '/auth/login', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) }, generation);
    const session = this.parse(sessionSchema, response);
    await this.applySession(session, generation);
    return session;
  }

  /** 회원가입. 이메일 확인이 필요하면 세션 없이 { confirmationRequired: true }를 돌려준다. */
  async signUp(email: string, password: string, displayName: string): Promise<{ confirmationRequired: true } | { confirmationRequired: false; session: Session }> {
    const generation = this.beginSessionChange();
    await this.persistToken(generation, null);
    const response = await this.sessionResponse({ method: 'POST', path: '/auth/signup', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password, display_name: displayName }) }, generation);
    const parsed = this.parse(signUpResultSchema, response);
    if (parsed.email_confirmation_required) return { confirmationRequired: true };
    const session = sessionSchema.parse(parsed);
    await this.applySession(session, generation);
    return { confirmationRequired: false, session };
  }

  createOrganization(name: string, slug: string): Promise<Organization> {
    return this.call('POST', '/organizations', organizationSchema, { name, slug });
  }

  async restoreSession(): Promise<{ authenticated: false } | { authenticated: true; session: Session }> {
    const generation = this.sessionGeneration;
    try {
      const session = await this.refreshOnce(generation);
      this.assertSession(generation);
      return { authenticated: true, session };
    } catch {
      // refresh owns current-session cleanup; stale restore failures must not clear a newer login.
      return { authenticated: false };
    }
  }

  async logout(): Promise<void> {
    const token=this.accessToken;
    const generation = this.beginSessionChange();
    await this.persistToken(generation, null);
    if(token){
      const response=await this.platform.request({method:'POST',path:'/auth/logout',headers:{Authorization:`Bearer ${token}`}});
      if(response.status<200||response.status>=300)throw apiError(response.status,response.body);
    }
  }

  /**
   * 관리자 API 서버(/admin/me)가 이 사용자를 플랫폼 관리자로 확인하는지. 관리자 API 주소가 없거나 호출이 실패하면 false(메뉴 숨김).
   * 성공한 결과는 로그아웃·다시 로그인할 때까지 재사용한다.
   */
  isPlatformAdmin(): Promise<boolean> {
    if (!this.platformAdmin) {
      const pending = this.call('GET', '/admin/me', z.object({ platform_admin: z.boolean() }))
        .then((result) => result.platform_admin)
        .catch(() => { if (this.platformAdmin === pending) this.platformAdmin = null; return false; });
      this.platformAdmin = pending;
    }
    return this.platformAdmin;
  }

  listOrganizations(): Promise<Organization[]> {
    return this.authed({ method: 'GET', path: '/organizations', headers: {} }, organizationsSchema);
  }

  listAuditEvents(organizationId: string, filters: { from?: string; to?: string; action?: string; limit?: number; cursor?: string } = {}) {
    const query = new URLSearchParams();
    for (const key of ['from', 'to', 'action', 'limit', 'cursor'] as const) {
      const value = filters[key];
      if (value !== undefined && value !== '') query.set(key, String(value));
    }
    const serialized = query.toString();
    const suffix = serialized ? `?${serialized}` : '';
    return this.call('GET', `/organizations/${organizationId}/audit-events${suffix}`, auditEventsPageSchema);
  }

  getEntitlements(organizationId: string): Promise<Entitlement> {
    return this.authed({ method: 'GET', path: `/organizations/${organizationId}/entitlements`, headers: {} }, entitlementSchema);
  }

  listCustomers(organizationId: string): Promise<Customer[]> { return this.authed({ method: 'GET', path: `/organizations/${organizationId}/customers`, headers: {} }, customersSchema); }
  getCustomer(o:string,c:string):Promise<Customer>{return this.call('GET',`/organizations/${o}/customers/${c}`,customerSchema)}
  createCustomer(organizationId: string, input: Omit<Customer, 'id'|'organization_id'>): Promise<Customer> { return this.authed({ method: 'POST', path: `/organizations/${organizationId}/customers`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, customerSchema); }
  updateCustomer(organizationId: string, customerId: string, patch: Partial<Omit<Customer, 'id'|'organization_id'>>): Promise<Customer> { return this.authed({ method: 'PATCH', path: `/organizations/${organizationId}/customers/${customerId}`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }, customerSchema); }
  archiveCustomer(organizationId: string, customerId: string): Promise<Customer> { return this.updateCustomer(organizationId, customerId, { status: 'archived' }); }
  getCustomerRetentionPolicy(o:string){return this.authed({method:'GET',path:`/organizations/${o}/customer-retention-policy`,headers:{}},customerRetentionPolicyResponseSchema)}
  saveCustomerRetentionPolicy(o:string,input:{expected_version:number;profile_days:number|null;sensitive_notes_days:number|null;treatment_photos_days:number|null;consent_records_days:number|null;transaction_records_days:number|null;dispute_records_days:number|null;audit_events_days:number|null}){return this.authed({method:'PUT',path:`/organizations/${o}/customer-retention-policy`,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)},customerRetentionPolicySchema)}
  getCustomerRetentionStatus(o:string,c:string){return this.authed({method:'GET',path:`/organizations/${o}/customers/${c}/retention-status`,headers:{}},customerRetentionStatusSchema)}
  setCustomerRelationshipEnd(o:string,c:string,ended_at:string|null,reason:string){return this.authed({method:'PUT',path:`/organizations/${o}/customers/${c}/relationship-end`,headers:{'Content-Type':'application/json'},body:JSON.stringify({ended_at,reason})},z.object({relationship_ended_at:z.string().nullable()}))}
  setCustomerLegalHold(o:string,c:string,active:boolean,reason:string){return this.authed({method:'PUT',path:`/organizations/${o}/customers/${c}/legal-hold`,headers:{'Content-Type':'application/json'},body:JSON.stringify({active,reason})},z.object({active:z.boolean()}))}
  listCustomerActivities(organizationId:string, customerId:string):Promise<CustomerActivity[]> { return this.authed({method:'GET',path:`/organizations/${organizationId}/customers/${customerId}/activities`,headers:{}},customerActivitiesSchema); }
  createCustomerActivity(organizationId:string, customerId:string, input:{activity_type:string;title:string;description:string;occurred_at:string|null}):Promise<CustomerActivity>{return this.authed({method:'POST',path:`/organizations/${organizationId}/customers/${customerId}/activities`,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)},customerActivitySchema);}
  getMobilePhoneDirectory(organizationId:string,cursor?:string){const suffix=cursor?`?cursor=${encodeURIComponent(cursor)}`:'';return this.call('GET',`/organizations/${organizationId}/mobile/phone-directory${suffix}`,phoneDirectoryPageSchema)}
  identifyMobileCaller(organizationId:string,number:string){return this.call('POST',`/organizations/${organizationId}/mobile/phone-identification`,phoneIdentificationSchema,{number})}
  listIncomingCalls(organizationId:string,after='',waitMs=8000){const query=new URLSearchParams({after,wait_ms:String(waitMs)});return this.call('GET',`/organizations/${organizationId}/mobile/incoming-calls?${query}`,incomingCallsPageSchema)}
  getPhoneRetentionConsent(o:string){return this.call('GET',`/organizations/${o}/phone/retention-consent`,phoneConsentSchema)}
  getPhoneInboxRecord(o:string,id:string,recipientId?:string){return this.call('GET',`/organizations/${o}/phone/inbox/${id}${recipientId?`?recipient_id=${encodeURIComponent(recipientId)}`:''}`,phoneInboxRecordSchema)}
  acknowledgePhoneInbox(o:string,id:string){return this.call('POST',`/organizations/${o}/phone/inbox/${id}/ack`,z.object({acknowledged:z.boolean()}),{})}
  setPhoneRetentionConsent(o:string,input:{enabled:boolean;expected_version:number;operation_id:string}){return this.call('PUT',`/organizations/${o}/phone/retention-consent`,phoneConsentSchema,input)}
  listPhoneInbox(o:string,input:PhoneInboxQuery={}){const query=new URLSearchParams();for(const [k,v] of Object.entries(input))if(v!==undefined)query.set(k,String(v));return this.call('GET',`/organizations/${o}/phone/inbox?${query}`,phoneInboxPageSchema)}
  respondPhoneInbox(o:string,id:string,input:PhoneResponse){return this.call('POST',`/organizations/${o}/phone/inbox/${id}/response`,phoneInboxRecordSchema,input)}
  getCallerProfile(o:string,customerId:string,number:string){return this.call('POST',`/organizations/${o}/phone/caller-profile`,callerProfileSchema,{customer_id:customerId,number})}
  createMobilePhoneMemo(organizationId:string,input:{customer_id:string;phone:string;memo:string;occurred_at:string|null}){return this.call('POST',`/organizations/${organizationId}/mobile/phone-memos`,customerActivitySchema,input)}
  async deleteCustomerActivity(organizationId:string,customerId:string,activityId:string):Promise<void>{await this.authedVoid({method:'DELETE',path:`/organizations/${organizationId}/customers/${customerId}/activities/${activityId}`,headers:{}});}
  getCustomerPhotoUploadStatus(o:string,c:string){return this.authed({method:'GET',path:`/organizations/${o}/customers/${c}/photos/upload-status`,headers:{}},photoUploadStatusSchema)}
  listCustomerPhotos(o:string,c:string):Promise<CustomerPhoto[]>{return this.authed({method:'GET',path:`/organizations/${o}/customers/${c}/photos`,headers:{}},customerPhotosSchema)}
  completeCustomerPhotoUpload(o:string,c:string,id:string):Promise<CustomerPhoto>{return this.authed({method:'POST',path:`/organizations/${o}/customers/${c}/photos/${id}/complete`,headers:{}},customerPhotoSchema)}
  createPhotoUploadUrl(o:string,c:string,input:{original_name:string;content_type:string;size_bytes:number;caption:string}):Promise<SignedPhoto>{return this.authed({method:'POST',path:`/organizations/${o}/customers/${c}/photos/upload-url`,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)},signedPhotoSchema)}
  createPhotoDownloadUrl(o:string,c:string,id:string):Promise<SignedPhoto>{return this.authed({method:'POST',path:`/organizations/${o}/customers/${c}/photos/${id}/download-url`,headers:{}},signedPhotoSchema)}
  listTrashedPhotos(o:string,c:string):Promise<TrashedPhoto[]>{return this.authed({method:'GET',path:`/organizations/${o}/customers/${c}/photos/trash`,headers:{}},trashedPhotosSchema)}
  restoreCustomerPhoto(o:string,c:string,id:string):Promise<CustomerPhoto>{return this.authed({method:'POST',path:`/organizations/${o}/customers/${c}/photos/${id}/restore`,headers:{}},customerPhotoSchema)}
  archiveCustomerPhoto(o:string,c:string,id:string):Promise<CustomerPhoto>{return this.authed({method:'DELETE',path:`/organizations/${o}/customers/${c}/photos/${id}`,headers:{}},customerPhotoSchema)}
  get filePlatform(): Platform{return this.platform;}
  listTasks(organizationId:string):Promise<Task[]>{return this.authed({method:'GET',path:`/organizations/${organizationId}/tasks`,headers:{}},tasksSchema)}
  listTaskPeople(organizationId:string):Promise<Array<{user_id:string;name:string}>>{return this.authed({method:'GET',path:`/organizations/${organizationId}/task-people`,headers:{}},taskPeopleSchema)}
  createTask(organizationId:string,input:{title:string;description:string;due_at:string|null;priority:'low'|'normal'|'high';labels?:string[];checklist?:Array<{id:string;text:string;done:boolean}>;recurrence?:'daily'|'weekly'|'monthly'|null;customer_id?:string|null;appointment_id?:string|null;assignee_id?:string|null}):Promise<Task>{return this.authed({method:'POST',path:`/organizations/${organizationId}/tasks`,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)},taskSchema)}
  updateTask(organizationId:string,taskId:string,patch:Partial<{title:string;description:string;due_at:string|null;priority:'low'|'normal'|'high';status:'open'|'in_progress'|'done'|'canceled';labels:string[];checklist:Array<{id:string;text:string;done:boolean}>;recurrence:'daily'|'weekly'|'monthly'|null;customer_id:string|null;appointment_id:string|null;assignee_id:string|null}>):Promise<Task>{return this.authed({method:'PATCH',path:`/organizations/${organizationId}/tasks/${taskId}`,headers:{'Content-Type':'application/json'},body:JSON.stringify(patch)},taskSchema)}
  async deleteTask(organizationId:string,taskId:string):Promise<void>{await this.authedVoid({method:'DELETE',path:`/organizations/${organizationId}/tasks/${taskId}`,headers:{}})}
  listAppointments(organizationId:string):Promise<Appointment[]>{return this.authed({method:'GET',path:`/organizations/${organizationId}/appointments`,headers:{}},appointmentsSchema)}
  listAppointmentStaff(o:string):Promise<AppointmentStaff[]>{return this.authed({method:'GET',path:`/organizations/${o}/appointment-staff`,headers:{}},appointmentStaffListSchema)}
  listAppointmentBranches(o:string){return this.authed({method:'GET',path:`/organizations/${o}/appointment-branches`,headers:{}},appointmentBranchesSchema)}
  listAppointmentServices(o:string):Promise<AppointmentService[]>{return this.authed({method:'GET',path:`/organizations/${o}/appointment-services`,headers:{}},appointmentServiceListSchema)}
  createAppointment(o:string,input:{customer_id:string;staff_id:string;service_id:string;start_at:string;source:string;expected_version:null;operation_id:string;resource_ids?:string[]}):Promise<Appointment>{return this.authed({method:'POST',path:`/organizations/${o}/appointments`,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)},appointmentSchema)}
  setAppointmentMemo(o:string,id:string,memo:string):Promise<Appointment>{return this.authed({method:'PUT',path:`/organizations/${o}/appointments/${id}/memo`,headers:{'Content-Type':'application/json'},body:JSON.stringify({memo})},appointmentSchema)}
  transitionAppointment(o:string,id:string,input:{target_status:string;reason:string|null;expected_version:number;operation_id:string}):Promise<Appointment>{return this.authed({method:'POST',path:`/organizations/${o}/appointments/${id}/transitions`,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)},appointmentSchema)}
  listOperationRecords(o:string,module:'treatments'|'sales'|'memberships'|'inventory'|'staff'|'finance'|'documents'|'files'):Promise<OperationRecord[]>{return this.authed({method:'GET',path:`/organizations/${o}/operations/${module}`,headers:{}},operationRecordsSchema)}
  createOperationRecord(o:string,module:'treatments'|'finance'|'documents',input:Record<string,unknown>):Promise<OperationRecord>{return this.authed({method:'POST',path:`/organizations/${o}/operations/${module}`,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)},operationRecordSchema)}
  updateOperationRecord(o:string,module:'finance'|'documents',id:string,input:Record<string,unknown>):Promise<OperationRecord>{return this.authed({method:'PATCH',path:`/organizations/${o}/operations/${module}/${id}`,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)},operationRecordSchema)}

  /** 모듈별 API가 쓰는 공개 호출 도우미. 경로는 /api/v1 이후부터 쓴다. */
  call<T>(method: 'GET'|'POST'|'PUT'|'PATCH'|'DELETE', path: string, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    return this.authed({ method, path, ...(path.startsWith('/admin/') ? { scope: 'admin' as const } : {}), headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, schema);
  }
  callVoid(method: 'POST'|'PUT'|'PATCH'|'DELETE', path: string, body?: unknown): Promise<void> {
    return this.authedVoid({ method, path, headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }

  private async authed<T>(request: HttpRequest, schema: z.ZodType<T>): Promise<T> {
    return this.parse(schema, await this.authenticatedResponse(request));
  }

  private async authenticatedResponse(request: HttpRequest): Promise<HttpResponse> {
    const generation = this.sessionGeneration;
    if (!this.accessToken) throw new ApiError(401, 'NOT_AUTHENTICATED', '로그인이 필요합니다.', false);
    let response = await this.sessionResponse({ ...request, headers: { ...request.headers, Authorization: `Bearer ${this.accessToken}` } }, generation);
    if (response.status === 401) {
      const session = await this.refreshOnce(generation);
      response = await this.sessionResponse({ ...request, headers: { ...request.headers, Authorization: `Bearer ${session.access_token}` } }, generation);
    }
    this.assertSession(generation);
    return response;
  }
  private async authedVoid(request: HttpRequest): Promise<void> {
    const response = await this.authenticatedResponse(request);
    if (response.status < 200 || response.status >= 300) throw apiError(response.status, response.body);
  }

  private async refreshOnce(generation: number): Promise<Session> {
    this.assertSession(generation);
    if (!this.refreshInFlight) {
      const pending = this.tokenWriteQueue.then(() => {
        this.assertSession(generation);
        return this.platform.tokenStore.load();
      }).then((token) => {
        this.assertSession(generation);
        if (!token) throw new ApiError(401, 'SESSION_EXPIRED', '세션이 만료되었습니다.', false);
        return this.refresh(token, generation);
      }).finally(() => { if (this.refreshInFlight === pending) this.refreshInFlight = null; });
      this.refreshInFlight = pending;
    }
    return this.refreshInFlight;
  }

  private async refresh(refreshToken: string, generation: number): Promise<Session> {
    try {
      const response = await this.sessionResponse({ method: 'POST', path: '/auth/refresh', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshToken }) }, generation);
      const session = this.parse(sessionSchema, response);
      await this.applySession(session, generation);
      return session;
    } catch (error) {
      this.assertSession(generation);
      this.accessToken = null;
      // 서버가 토큰을 거절한 경우(401/403)에만 저장된 토큰을 지운다. 429·5xx·네트워크 오류는 일시적이다.
      const status = error instanceof ApiError ? error.status : 0;
      if (status === 401 || status === 403) await this.persistToken(generation, null);
      throw error;
    }
  }

  private async applySession(session: Session, generation: number): Promise<void> {
    this.assertSession(generation);
    await this.persistToken(generation, session.refresh_token);
    this.assertSession(generation);
    this.accessToken = session.access_token;
  }

  private beginSessionChange(): number {
    this.sessionGeneration++;
    this.accessToken = null;
    this.refreshInFlight = null;
    this.platformAdmin = null;
    return this.sessionGeneration;
  }

  private assertSession(generation: number): void {
    if (generation !== this.sessionGeneration) throw new ApiError(0, 'SESSION_CHANGED', '로그인 상태가 변경되어 이전 요청을 취소했습니다.', false);
  }

  private persistToken(generation: number, token: string | null): Promise<void> {
    const pending = this.tokenWriteQueue.then(async () => {
      this.assertSession(generation);
      try {
        if (token) await this.platform.tokenStore.save(token);
        else await this.platform.tokenStore.clear();
      } finally { this.assertSession(generation); }
    });
    // A failed write must not prevent a subsequent logout clear or new-account save.
    this.tokenWriteQueue = pending.catch(() => undefined);
    return pending;
  }

  private async sessionResponse(request: HttpRequest, generation: number): Promise<HttpResponse> {
    this.assertSession(generation);
    try {
      const response = await this.send(request);
      this.assertSession(generation);
      return response;
    } catch (error) { this.assertSession(generation); throw error; }
  }

  private async send(request: HttpRequest): Promise<HttpResponse> {
    try { return await this.platform.request(request); }
    catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(0, 'NETWORK_ERROR', error instanceof Error ? error.message : '네트워크에 연결할 수 없습니다.', true);
    }
  }

  private parse<T>(schema: z.ZodType<T>, response: HttpResponse): T {
    if (response.status < 200 || response.status >= 300) throw apiError(response.status, response.body);
    let body: unknown;
    try { body = JSON.parse(response.body); }
    catch { throw new ApiError(response.status, 'INVALID_RESPONSE', '서버 응답을 읽을 수 없습니다.', false); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ApiError(response.status, 'INVALID_RESPONSE', '서버 응답 형식이 올바르지 않습니다.', false);
    return parsed.data;
  }
}
