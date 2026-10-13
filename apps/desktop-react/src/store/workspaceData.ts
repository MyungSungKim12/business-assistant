import type { ApiClient } from '../api/client';
import { appointmentsSchema, type Appointment, type Customer, type Task } from '../api/schemas';
import { workspaceCache } from './ttlCache';

/** 검색·알림이 읽는 기존 API의 부분. 테스트에서는 이 메서드만 가진 가짜를 넣는다. */
export type WorkspaceDataApi = Pick<ApiClient, 'listCustomers' | 'listTasks' | 'call' | 'listOperationRecords'>;

export const customersKey = (organizationId: string) => `${organizationId}:customers`;

export function loadCustomers(api: WorkspaceDataApi, organizationId: string, maxAgeMs: number): Promise<Customer[]> {
  return workspaceCache.get(customersKey(organizationId), () => api.listCustomers(organizationId), maxAgeMs);
}

export function loadTasks(api: WorkspaceDataApi, organizationId: string, maxAgeMs: number): Promise<Task[]> {
  return workspaceCache.get(`${organizationId}:tasks`, () => api.listTasks(organizationId), maxAgeMs);
}

/** from~to(YYYY-MM-DD, 서버 기준 날짜) 예약. */
export function loadAppointments(api: WorkspaceDataApi, organizationId: string, from: string, to: string, maxAgeMs: number): Promise<Appointment[]> {
  return workspaceCache.get(
    `${organizationId}:appointments:${from}:${to}`,
    () => api.call('GET', `/organizations/${organizationId}/appointments?from_date=${from}&to_date=${to}`, appointmentsSchema),
    maxAgeMs,
  );
}

export function loadWalletRecords(api: WorkspaceDataApi, organizationId: string, maxAgeMs: number): Promise<Array<Record<string, unknown>>> {
  return workspaceCache.get(`${organizationId}:wallets`, () => api.listOperationRecords(organizationId, 'memberships'), maxAgeMs);
}

/** 기능이 켜져 있지 않은 매장(403)은 오류가 아니라 "해당 없음"으로 본다. 그 밖의 실패만 일부 불러오기 실패로 알린다. */
export const isRealFailure = (result: PromiseSettledResult<unknown>): boolean =>
  result.status === 'rejected' && (result.reason as { status?: number } | null)?.status !== 403;
