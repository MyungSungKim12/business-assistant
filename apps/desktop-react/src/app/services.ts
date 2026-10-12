import type { Session, Organization, Entitlement } from '../api/schemas';
import type { Platform } from '../platform/types';

export interface AppApi {
  login(email: string, password: string): Promise<Session>;
  restoreSession(): Promise<{ authenticated: false } | { authenticated: true; session: Session }>;
  logout(): Promise<void>;
  listOrganizations(): Promise<Organization[]>;
  getEntitlements(organizationId: string): Promise<Entitlement>;
}

export interface AppServices { api: AppApi; platform: Platform }
