import { z } from 'zod';

export const ROLES = ['owner', 'admin', 'member'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABELS: Record<Role, string> = { owner: '소유자', admin: '관리자', member: '구성원' };

export const memberSchema = z.object({
  user_id: z.uuid(),
  email: z.string().nullable(),
  display_name: z.string().nullable(),
  role: z.enum(ROLES),
  joined_at: z.string(),
});
export type Member = z.infer<typeof memberSchema>;
export const membersSchema = z.array(memberSchema);
export const memberRefSchema = z.object({ user_id: z.uuid(), role: z.enum(ROLES) });

export interface Actor { userId: string; role: Role }

const ownerCount = (members: Member[]) => members.filter((member) => member.role === 'owner').length;

/** 이 사용자가 목록의 대상에게 할 수 있는 일. 서버(DB 함수)가 같은 규칙을 다시 검사한다. */
export interface MemberAbilities {
  /** 역할 변경 가능 여부와 불가 사유 */
  changeRole: { allowed: boolean; reason?: string };
  remove: { allowed: boolean; reason?: string };
}

export function memberAbilities(actor: Actor, target: Member, members: Member[]): MemberAbilities {
  const isSelf = target.user_id === actor.userId;
  const lastOwner = target.role === 'owner' && ownerCount(members) <= 1;
  const changeRole = (): MemberAbilities['changeRole'] => {
    if (actor.role !== 'owner') return { allowed: false, reason: '역할 변경은 소유자만 할 수 있습니다.' };
    if (isSelf) return { allowed: false, reason: '본인의 역할은 바꿀 수 없습니다.' };
    if (lastOwner) return { allowed: false, reason: '마지막 소유자는 강등할 수 없습니다.' };
    return { allowed: true };
  };
  const remove = (): MemberAbilities['remove'] => {
    if (isSelf) return { allowed: false, reason: '본인은 제거할 수 없습니다.' };
    if (actor.role === 'admin' && target.role !== 'member') return { allowed: false, reason: '관리자는 일반 구성원만 제거할 수 있습니다.' };
    if (lastOwner) return { allowed: false, reason: '마지막 소유자는 제거할 수 없습니다.' };
    return { allowed: true };
  };
  return { changeRole: changeRole(), remove: remove() };
}

/** 구성원을 추가할 때 고를 수 있는 역할. 소유자는 관리자·구성원, 관리자는 구성원만. */
export const addableRoles = (actorRole: Role): Role[] => (actorRole === 'owner' ? ['member', 'admin'] : ['member']);

/** 서버 오류(코드·상태)를 화면 안내로 바꾼다. */
export function memberErrorMessage(reason: unknown, fallback: string): string {
  const failure = reason as { status?: number; code?: string; message?: string } | null;
  switch (failure?.code) {
    case 'member_user_not_found': return '가입한 사용자를 찾을 수 없습니다. 상대방이 먼저 가입한 뒤 다시 시도해 주세요.';
    case 'already_member': return '이미 이 매장의 구성원입니다.';
    case 'last_owner': return '마지막 소유자는 강등하거나 제거할 수 없습니다.';
    case 'self_change': return '본인의 역할은 바꾸거나 제거할 수 없습니다.';
    case 'invalid_email': return '이메일 형식을 확인해 주세요.';
    default: break;
  }
  if (failure?.status === 403) return '이 작업을 할 권한이 없습니다.';
  if (failure?.status === 429) return failure.message?.trim() || '시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.';
  if (failure?.status === 422) return '입력값을 확인해 주세요.';
  return fallback;
}
