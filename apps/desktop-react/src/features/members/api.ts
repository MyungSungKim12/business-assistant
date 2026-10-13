import type { ApiClient } from '../../api/client';
import { memberRefSchema, membersSchema, type Member, type Role } from './memberRules';

/** 구성원 API가 쓰는 ApiClient의 부분. 테스트에서는 이 메서드만 가진 가짜를 넣는다. */
export type MembersApiClient = Pick<ApiClient, 'call' | 'callVoid'>;

const base = (organizationId: string) => `/organizations/${organizationId}/members`;

export const membersApi = {
  list: (api: MembersApiClient, organizationId: string): Promise<Member[]> => api.call('GET', `${base(organizationId)}/detail`, membersSchema),
  /** 이미 가입한 사용자의 이메일로 구성원을 추가한다. */
  add: (api: MembersApiClient, organizationId: string, email: string, role: Role) => api.call('POST', base(organizationId), memberRefSchema, { email, role }),
  setRole: (api: MembersApiClient, organizationId: string, userId: string, role: Role) => api.call('PATCH', `${base(organizationId)}/${userId}`, memberRefSchema, { role }),
  remove: (api: MembersApiClient, organizationId: string, userId: string): Promise<void> => api.callVoid('DELETE', `${base(organizationId)}/${userId}`),
};
