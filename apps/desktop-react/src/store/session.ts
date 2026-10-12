import { create } from 'zustand';
import type { AuthUser, Entitlement, Organization } from '../api/schemas';

interface SessionState {
  user: AuthUser | null;
  organization: Organization | null;
  entitlement: Entitlement | null;
  setUser(user: AuthUser | null): void;
  selectOrganization(organization: Organization, entitlement: Entitlement): void;
  reset(): void;
}

export const useSessionStore = create<SessionState>((set) => ({
  user: null, organization: null, entitlement: null,
  setUser: (user) => set({ user }),
  selectOrganization: (organization, entitlement) => set({ organization, entitlement }),
  reset: () => set({ user: null, organization: null, entitlement: null }),
}));
