import { create } from 'zustand';
import type { CustomerInput } from './types';
type DraftState = { drafts: Record<string, CustomerInput>; put(key: string, draft: CustomerInput): void; clear(key: string): void };
export const customerDraftKey = (organizationId: string, customerId?: string) => `${organizationId}:customers:${customerId ?? 'new'}`;
export const useCustomerDraftStore = create<DraftState>((set) => ({ drafts: {}, put: (key,draft) => set((state) => ({ drafts: { ...state.drafts, [key]: draft } })), clear: (key) => set((state) => { const { [key]: _, ...drafts } = state.drafts; return { drafts }; }) }));
