import type { z } from 'zod';

import type { Platform } from '../platform/types';
import { ApiError, apiError } from './errors';
import { customerActivitySchema, customerActivitiesSchema, customerPhotoSchema, customerPhotosSchema, customerSchema, customersSchema, entitlementSchema, organizationsSchema, sessionSchema, signedPhotoSchema, type Customer, type CustomerActivity, type CustomerPhoto, type Entitlement, type Organization, type Session, type SignedPhoto } from './schemas';
import type { HttpRequest, HttpResponse } from './transport';

export class ApiClient {
  private accessToken: string | null = null;
  private refreshInFlight: Promise<Session> | null = null;

  constructor(private readonly platform: Platform) {}

  async login(email: string, password: string): Promise<Session> {
    const response = await this.send({ method: 'POST', path: '/auth/login', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    const session = this.parse(sessionSchema, response);
    await this.applySession(session);
    return session;
  }

  async restoreSession(): Promise<{ authenticated: false } | { authenticated: true; session: Session }> {
    const token = await this.platform.tokenStore.load();
    if (!token) return { authenticated: false };
    try {
      const session = await this.refresh(token);
      return { authenticated: true, session };
    } catch {
      this.accessToken = null;
      await this.platform.tokenStore.clear();
      return { authenticated: false };
    }
  }

  async logout(): Promise<void> {
    this.accessToken = null;
    await this.platform.tokenStore.clear();
  }

  listOrganizations(): Promise<Organization[]> {
    return this.authed({ method: 'GET', path: '/organizations', headers: {} }, organizationsSchema);
  }

  getEntitlements(organizationId: string): Promise<Entitlement> {
    return this.authed({ method: 'GET', path: `/organizations/${organizationId}/entitlements`, headers: {} }, entitlementSchema);
  }

  listCustomers(organizationId: string): Promise<Customer[]> { return this.authed({ method: 'GET', path: `/organizations/${organizationId}/customers`, headers: {} }, customersSchema); }
  createCustomer(organizationId: string, input: Omit<Customer, 'id'|'organization_id'>): Promise<Customer> { return this.authed({ method: 'POST', path: `/organizations/${organizationId}/customers`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }, customerSchema); }
  updateCustomer(organizationId: string, customerId: string, patch: Partial<Omit<Customer, 'id'|'organization_id'>>): Promise<Customer> { return this.authed({ method: 'PATCH', path: `/organizations/${organizationId}/customers/${customerId}`, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) }, customerSchema); }
  archiveCustomer(organizationId: string, customerId: string): Promise<Customer> { return this.authed({ method: 'DELETE', path: `/organizations/${organizationId}/customers/${customerId}`, headers: {} }, customerSchema); }
  listCustomerActivities(organizationId:string, customerId:string):Promise<CustomerActivity[]> { return this.authed({method:'GET',path:`/organizations/${organizationId}/customers/${customerId}/activities`,headers:{}},customerActivitiesSchema); }
  createCustomerActivity(organizationId:string, customerId:string, input:{activity_type:string;title:string;description:string;occurred_at:string|null}):Promise<CustomerActivity>{return this.authed({method:'POST',path:`/organizations/${organizationId}/customers/${customerId}/activities`,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)},customerActivitySchema);}
  async deleteCustomerActivity(organizationId:string,customerId:string,activityId:string):Promise<void>{await this.authedVoid({method:'DELETE',path:`/organizations/${organizationId}/customers/${customerId}/activities/${activityId}`,headers:{}});}
  listCustomerPhotos(o:string,c:string):Promise<CustomerPhoto[]>{return this.authed({method:'GET',path:`/organizations/${o}/customers/${c}/photos`,headers:{}},customerPhotosSchema)}
  createPhotoUploadUrl(o:string,c:string,input:{original_name:string;content_type:string;size_bytes:number;caption:string}):Promise<SignedPhoto>{return this.authed({method:'POST',path:`/organizations/${o}/customers/${c}/photos/upload-url`,headers:{'Content-Type':'application/json'},body:JSON.stringify(input)},signedPhotoSchema)}
  createPhotoDownloadUrl(o:string,c:string,id:string):Promise<SignedPhoto>{return this.authed({method:'POST',path:`/organizations/${o}/customers/${c}/photos/${id}/download-url`,headers:{}},signedPhotoSchema)}
  archiveCustomerPhoto(o:string,c:string,id:string):Promise<CustomerPhoto>{return this.authed({method:'DELETE',path:`/organizations/${o}/customers/${c}/photos/${id}`,headers:{}},customerPhotoSchema)}
  get filePlatform(): Platform{return this.platform;}

  private async authed<T>(request: HttpRequest, schema: z.ZodType<T>): Promise<T> {
    if (!this.accessToken) throw new ApiError(401, 'NOT_AUTHENTICATED', '로그인이 필요합니다.', false);
    let response = await this.send({ ...request, headers: { ...request.headers, Authorization: `Bearer ${this.accessToken}` } });
    if (response.status === 401) {
      const session = await this.refreshOnce();
      response = await this.send({ ...request, headers: { ...request.headers, Authorization: `Bearer ${session.access_token}` } });
    }
    return this.parse(schema, response);
  }
  private async authedVoid(request: HttpRequest): Promise<void> { if (!this.accessToken) throw new ApiError(401,'NOT_AUTHENTICATED','로그인이 필요합니다.',false); let response=await this.send({...request,headers:{...request.headers,Authorization:`Bearer ${this.accessToken}`}}); if(response.status===401){const session=await this.refreshOnce();response=await this.send({...request,headers:{...request.headers,Authorization:`Bearer ${session.access_token}`}});} if(response.status<200||response.status>=300)throw apiError(response.status,response.body); }

  private async refreshOnce(): Promise<Session> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.platform.tokenStore.load().then((token) => {
        if (!token) throw new ApiError(401, 'SESSION_EXPIRED', '세션이 만료되었습니다.', false);
        return this.refresh(token);
      }).finally(() => { this.refreshInFlight = null; });
    }
    return this.refreshInFlight;
  }

  private async refresh(refreshToken: string): Promise<Session> {
    try {
      const response = await this.send({ method: 'POST', path: '/auth/refresh', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: refreshToken }) });
      const session = this.parse(sessionSchema, response);
      await this.applySession(session);
      return session;
    } catch (error) {
      this.accessToken = null;
      await this.platform.tokenStore.clear();
      throw error;
    }
  }

  private async applySession(session: Session): Promise<void> {
    this.accessToken = session.access_token;
    if (session.refresh_token) await this.platform.tokenStore.save(session.refresh_token);
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
