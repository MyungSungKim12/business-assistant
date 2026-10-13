import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog, NoticeHost } from '@business-assistant/react-ui';
import { usePreferences } from '../../store/preferences';
import { MembersPage } from './MembersPage';
import type { MembersApiClient } from './api';
import { addableRoles, memberAbilities, memberErrorMessage, type Member, type Role } from './memberRules';

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ORG = ID(900);
const ME = ID(1);
const member = (n: number, role: Role, patch: Partial<Member> = {}): Member => ({
  user_id: ID(n), email: `user${n}@example.com`, display_name: `사용자${n}`, role, joined_at: '2026-10-01T15:30:00Z', ...patch,
});

interface Call { method: string; path: string; body?: unknown }
function fakeApi(initial: Member[], failWith?: Record<string, unknown>) {
  let members = initial;
  const calls: Call[] = [];
  const fail = () => { if (failWith) throw failWith; };
  const api = {
    call: vi.fn(async (method: string, path: string, _schema: unknown, body?: unknown) => {
      calls.push({ method, path, body });
      if (method === 'GET') return members;
      fail();
      if (method === 'POST') { const { email, role } = body as { email: string; role: Role }; members = [...members, member(50, role, { email })]; return { user_id: ID(50), role }; }
      const { role } = body as { role: Role };
      const userId = path.split('/').pop()!;
      members = members.map((item) => (item.user_id === userId ? { ...item, role } : item));
      return { user_id: userId, role };
    }),
    callVoid: vi.fn(async (method: string, path: string) => {
      calls.push({ method, path });
      fail();
      members = members.filter((item) => item.user_id !== path.split('/').pop());
    }),
  };
  return { api: api as unknown as MembersApiClient, calls };
}

function setup(members: Member[], role: Role = 'owner', failWith?: Record<string, unknown>) {
  const server = fakeApi(members, failWith);
  render(<><NoticeHost /><ConfirmDialog /><MembersPage api={server.api} organizationId={ORG} currentUserId={ME} currentRole={role} /></>);
  return server;
}
const roleSelect = (n: number) => screen.getByLabelText(`user${n}@example.com 역할`);
/** 확인 창(dialog) 안의 버튼을 누른다. 목록 행에도 같은 이름의 버튼이 있다. */
const confirmWith = async (label: string) => fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: label }));

beforeEach(() => { usePreferences.getState().load(null); });

describe('MembersPage', () => {
  it('구성원 목록을 이메일·표시 이름·역할·가입일(KST)로 보여 준다', async () => {
    setup([member(1, 'owner'), member(2, 'member')]);
    expect(await screen.findByText('user2@example.com')).toBeInTheDocument();
    const row = screen.getByText('user2@example.com').closest('tr')!;
    expect(within(row).getByText('사용자2')).toBeInTheDocument();
    expect(within(row).getByText('2026-10-02')).toBeInTheDocument();
    expect(roleSelect(2)).toHaveValue('member');
    expect(screen.getByText('나')).toBeInTheDocument();
  });

  it('구성원(member) 역할이면 사용할 수 없다고 안내하고 요청하지 않는다', () => {
    const { api } = setup([member(1, 'member')], 'member');
    expect(screen.getByText(/소유자와 관리자만/)).toBeInTheDocument();
    expect(api.call).not.toHaveBeenCalled();
  });

  it('역할을 바꾸면 확인 후 요청하고 목록을 새로 불러온다', async () => {
    const { calls } = setup([member(1, 'owner'), member(2, 'member')]);
    await screen.findByText('user2@example.com');
    fireEvent.change(roleSelect(2), { target: { value: 'admin' } });
    await confirmWith('변경');
    await waitFor(() => expect(roleSelect(2)).toHaveValue('admin'));
    expect(calls.find((call) => call.method === 'PATCH')).toEqual({ method: 'PATCH', path: `/organizations/${ORG}/members/${ID(2)}`, body: { role: 'admin' } });
    expect(await screen.findByText('역할을 바꿨습니다.')).toBeInTheDocument();
  });

  it('확인에서 취소하면 요청하지 않는다', async () => {
    const { calls } = setup([member(1, 'owner'), member(2, 'member')]);
    await screen.findByText('user2@example.com');
    fireEvent.change(roleSelect(2), { target: { value: 'admin' } });
    fireEvent.click(await screen.findByRole('button', { name: '취소' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: '변경' })).not.toBeInTheDocument());
    expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
  });

  it('본인 역할·본인 제거·마지막 소유자 강등은 막는다', async () => {
    setup([member(1, 'owner'), member(2, 'member')]);
    await screen.findByText('user2@example.com');
    expect(roleSelect(1)).toBeDisabled();
    const mine = screen.getByText('user1@example.com').closest('tr')!;
    expect(within(mine).getByRole('button', { name: '제거' })).toBeDisabled();
  });

  it('소유자가 둘이면 다른 소유자는 강등·제거할 수 있고 마지막 소유자는 막는다', () => {
    const owners = [member(1, 'owner'), member(2, 'owner')];
    const actor = { userId: ME, role: 'owner' as const };
    expect(memberAbilities(actor, owners[1], owners)).toEqual({ changeRole: { allowed: true }, remove: { allowed: true } });
    const single = [member(1, 'owner'), member(2, 'admin')];
    expect(memberAbilities({ userId: ID(2), role: 'admin' }, single[0], single).remove.allowed).toBe(false);
    expect(memberAbilities({ userId: ID(9), role: 'owner' }, single[0], single).changeRole.reason).toContain('마지막 소유자');
  });

  it('관리자는 구성원만 제거할 수 있고 역할은 바꿀 수 없다', async () => {
    setup([member(1, 'admin'), member(2, 'owner'), member(3, 'member')], 'admin');
    await screen.findByText('user2@example.com');
    expect(roleSelect(2)).toBeDisabled();
    expect(roleSelect(3)).toBeDisabled();
    expect(within(screen.getByText('user2@example.com').closest('tr')!).getByRole('button', { name: '제거' })).toBeDisabled();
    expect(within(screen.getByText('user3@example.com').closest('tr')!).getByRole('button', { name: '제거' })).toBeEnabled();
    expect(addableRoles('admin')).toEqual(['member']);
    expect(addableRoles('owner')).toEqual(['member', 'admin']);
  });

  it('제거는 확인 후 요청한다', async () => {
    const { calls } = setup([member(1, 'owner'), member(2, 'member')]);
    await screen.findByText('user2@example.com');
    fireEvent.click(within(screen.getByText('user2@example.com').closest('tr')!).getByRole('button', { name: '제거' }));
    await confirmWith('제거');
    await waitFor(() => expect(screen.queryByText('user2@example.com')).not.toBeInTheDocument());
    expect(calls.find((call) => call.method === 'DELETE')).toEqual({ method: 'DELETE', path: `/organizations/${ORG}/members/${ID(2)}` });
  });

  it('이메일로 구성원을 추가하고 입력을 비운다', async () => {
    const { calls } = setup([member(1, 'owner')]);
    await screen.findByText('user1@example.com');
    fireEvent.change(screen.getByLabelText('가입한 사용자의 이메일'), { target: { value: '  New@Example.com ' } });
    fireEvent.change(screen.getByLabelText('추가할 역할'), { target: { value: 'admin' } });
    fireEvent.click(screen.getByRole('button', { name: '구성원 추가' }));
    expect(await screen.findByText('new@example.com')).toBeInTheDocument();
    expect(calls.find((call) => call.method === 'POST')).toEqual({ method: 'POST', path: `/organizations/${ORG}/members`, body: { email: 'new@example.com', role: 'admin' } });
    expect(screen.getByLabelText('가입한 사용자의 이메일')).toHaveValue('');
  });

  it('잘못된 이메일은 보내지 않는다', async () => {
    const { calls } = setup([member(1, 'owner')]);
    await screen.findByText('user1@example.com');
    fireEvent.change(screen.getByLabelText('가입한 사용자의 이메일'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: '구성원 추가' }));
    expect(screen.getByRole('alert')).toHaveTextContent('이메일 형식');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('가입하지 않은 이메일이면 가입 후 다시 시도하라고 안내하고 입력을 남긴다', async () => {
    setup([member(1, 'owner')], 'owner', { status: 404, code: 'member_user_not_found' });
    await screen.findByText('user1@example.com');
    fireEvent.change(screen.getByLabelText('가입한 사용자의 이메일'), { target: { value: 'none@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: '구성원 추가' }));
    expect(await screen.findByText(/가입한 사용자를 찾을 수 없습니다/)).toBeInTheDocument();
    expect(screen.getByLabelText('가입한 사용자의 이메일')).toHaveValue('none@example.com');
  });

  it('전화번호 가림 옵션이 켜져 있으면 이메일을 일부 가려 보여 준다', async () => {
    usePreferences.getState().load('u1');
    usePreferences.getState().setMaskPhone(true);
    setup([member(1, 'owner'), member(2, 'member')]);
    expect(await screen.findAllByText('u****@example.com', { exact: false })).toHaveLength(2);
    expect(screen.queryByText('user2@example.com')).not.toBeInTheDocument();
  });

  it('목록 로드 실패는 다시 시도를 제공한다', async () => {
    const api = { call: vi.fn().mockRejectedValueOnce({ status: 503 }).mockResolvedValue([member(1, 'owner')]), callVoid: vi.fn() } as unknown as MembersApiClient;
    render(<MembersPage api={api} organizationId={ORG} currentUserId={ME} currentRole="owner" />);
    fireEvent.click(await screen.findByRole('button', { name: '다시 시도' }));
    expect(await screen.findByText('user1@example.com')).toBeInTheDocument();
  });
});

describe('memberErrorMessage', () => {
  it('서버 코드별 안내', () => {
    expect(memberErrorMessage({ code: 'last_owner' }, 'x')).toContain('마지막 소유자');
    expect(memberErrorMessage({ code: 'already_member' }, 'x')).toContain('이미');
    expect(memberErrorMessage({ status: 403 }, 'x')).toContain('권한');
    expect(memberErrorMessage({ status: 429, message: '30초 후 다시' }, 'x')).toBe('30초 후 다시');
    expect(memberErrorMessage(new Error('?'), '기본')).toBe('기본');
  });
});
