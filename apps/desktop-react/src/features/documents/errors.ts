import { ApiError } from '../../api/errors';

export const statusOf = (error: unknown): number => (error instanceof ApiError ? error.status : 0);
/** 서버가 요청을 확정적으로 거절한 상태. 이 경우 같은 요청을 재시도할 필요가 없다. */
export const isDefinitive = (status: number): boolean => [400, 401, 403, 404, 409, 422].includes(status);
export function messageFor(error: unknown, byStatus: Partial<Record<number, string>>, fallback: string): string {
  return byStatus[statusOf(error)] ?? fallback;
}
export const newOperationId = (): string => crypto.randomUUID();
export const formatTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ko-KR');
};
