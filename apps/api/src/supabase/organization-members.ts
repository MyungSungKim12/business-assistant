import { z } from 'zod';
import { ApiFailure } from '../errors.js';

export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export const memberDetail = z.object({
  user_id: z.uuid(),
  email: z.string().nullable(),
  display_name: z.string().nullable(),
  role: z.enum(MEMBER_ROLES),
  joined_at: z.string(),
});
export type MemberDetail = z.infer<typeof memberDetail>;
export const memberRef = z.object({ user_id: z.uuid(), role: z.enum(MEMBER_ROLES) });

/** 구성원 RPC 가 raise exception 으로 돌려주는 업무 규칙 코드와 응답 매핑. */
const RULES: Record<string, { status: number; detail: string; code: string }> = {
  forbidden: { status: 403, detail: 'Organization management permission required', code: 'forbidden' },
  user_not_found: { status: 404, detail: 'User not found', code: 'member_user_not_found' },
  member_not_found: { status: 404, detail: 'Member not found', code: 'member_not_found' },
  already_member: { status: 409, detail: 'Already a member', code: 'already_member' },
  last_owner: { status: 409, detail: 'Last owner cannot be changed', code: 'last_owner' },
  self_change: { status: 409, detail: 'Own role cannot be changed', code: 'self_change' },
  invalid_role: { status: 422, detail: 'Invalid role', code: 'invalid_role' },
  invalid_email: { status: 422, detail: 'Invalid email', code: 'invalid_email' },
};

/** RPC 오류 본문의 message 를 업무 규칙 응답으로 바꾼다. 알 수 없으면 null(호출자가 일반 오류로 처리). */
export function memberRuleFailure(status: number, body: unknown): ApiFailure | null {
  if (status === 401) return new ApiFailure(401, 'Not authenticated');
  const message = typeof body === 'object' && body !== null && 'message' in body ? String((body as { message: unknown }).message).trim() : '';
  const rule = RULES[message];
  if (rule) return new ApiFailure(rule.status, rule.detail, { code: rule.code });
  if (status === 403) return new ApiFailure(403, 'Access denied');
  return null;
}

export const memberEmailInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  role: z.enum(['admin', 'member']).default('member'),
}).strict();
export const memberRoleInput = z.object({ role: z.enum(MEMBER_ROLES) }).strict();
