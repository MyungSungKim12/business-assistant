/** 서비스별 담당 가능 직원 규칙(SVC-11). 서비스 ID → 직원 ID 목록이며, 항목이 없는 서비스는 모든 직원이 가능하다. */
export type ServiceStaffMap = Record<string, string[]>;

export function buildServiceStaffMap(rows: Array<{ service_id: string; staff_id: string }>): ServiceStaffMap {
  const map: ServiceStaffMap = {};
  for (const row of rows) (map[row.service_id] ??= []).push(row.staff_id);
  return map;
}

/** 이 직원이 그 서비스를 맡을 수 있는지. 지정이 없는 서비스, 서비스를 아직 고르지 않은 경우는 가능으로 본다. */
export function canStaffDoService(map: ServiceStaffMap, serviceId: string, staffId: string): boolean {
  if (!serviceId) return true;
  const allowed = map[serviceId];
  return !allowed || allowed.length === 0 || allowed.includes(staffId);
}

/** 서비스 목록 표에 보일 요약: 제한이 없으면 '모든 직원', 있으면 이름 또는 'N명'. */
export function staffSummary(map: ServiceStaffMap, serviceId: string, nameOf: (staffId: string) => string): string {
  const allowed = map[serviceId];
  if (!allowed || allowed.length === 0) return '모든 직원';
  return allowed.length <= 2 ? allowed.map(nameOf).join(', ') : `${allowed.length}명`;
}
