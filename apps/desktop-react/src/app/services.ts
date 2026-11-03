import type { Session, Organization, Entitlement } from '../api/schemas';
import type { Platform } from '../platform/types';

export interface AppApi {
  getPhoneRetentionConsent?(organizationId:string):Promise<{enabled:boolean;version:number;retention_days:30}>;
  sendAccountEmail?(email:string,type:'recovery'|'signup'):Promise<void>;
  listAccountSessions?(cursor?:string):Promise<{current_session_id:string;items:Array<{session_id:string;created_at:string;last_active_at:string|null;user_agent:string|null;is_current:boolean}>;total:number;next_cursor:string|null}>;
  revokeAccountSessions?(sessionId:string|null):Promise<{current_revoked:boolean}>;
  login(email: string, password: string): Promise<Session>;
  restoreSession(): Promise<{ authenticated: false } | { authenticated: true; session: Session }>;
  logout(): Promise<void>;
  listOrganizations(): Promise<Organization[]>;
  getEntitlements(organizationId: string): Promise<Entitlement>;
  signUp?(email: string, password: string, displayName: string): Promise<{ confirmationRequired: true } | { confirmationRequired: false; session: Session }>;
  createOrganization?(name: string, slug: string): Promise<Organization>;
}

export interface AppServices { api: AppApi; platform: Platform }
