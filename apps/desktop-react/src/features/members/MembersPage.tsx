import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ErrorState, LoadingState, Select, confirm, notify } from '@business-assistant/react-ui';
import { usePrivacy } from '../../lib/privacy';
import { kstDateKey } from '../notifications/kstTime';
import { membersApi, type MembersApiClient } from './api';
import { ROLES, ROLE_LABELS, addableRoles, memberAbilities, memberErrorMessage, type Member, type Role } from './memberRules';
import './members.css';

export interface MembersPageProps {
  api: MembersApiClient;
  organizationId: string;
  /** 로그인한 사용자 ID와 그 조직에서의 역할 */
  currentUserId: string;
  currentRole: Role;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** 구성원 관리(소유자·관리자 전용): 목록, 가입한 사용자의 이메일로 추가, 역할 변경, 제거. 서버가 같은 규칙을 다시 검사한다. */
export function MembersPage({ api, organizationId, currentUserId, currentRole }: MembersPageProps) {
  const privacy = usePrivacy();
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState('');
  const [busy, setBusy] = useState(false);
  const canManage = currentRole === 'owner' || currentRole === 'admin';
  const actor = { userId: currentUserId, role: currentRole };

  const load = useCallback(async () => {
    setLoadError('');
    try { setMembers(await membersApi.list(api, organizationId)); }
    catch (reason) { setMembers(null); setLoadError(memberErrorMessage(reason, '구성원 목록을 불러오지 못했습니다.')); }
  }, [api, organizationId]);
  useEffect(() => { if (canManage) void load(); }, [canManage, load]);

  /** 변경 요청을 보내고 목록을 새로 불러온다. 실패하면 서버 안내를 알린다. */
  async function run(action: () => Promise<unknown>, success: string, failure: string): Promise<boolean> {
    setBusy(true);
    try {
      await action();
      notify.success(success);
      await load();
      return true;
    } catch (reason) {
      notify.error(memberErrorMessage(reason, failure));
      return false;
    } finally { setBusy(false); }
  }

  async function changeRole(member: Member, role: Role) {
    if (role === member.role) return;
    const message = `${memberLabel(member)}의 역할을 ${ROLE_LABELS[member.role]}에서 ${ROLE_LABELS[role]}(으)로 바꿉니다.`;
    if (!(await confirm({ title: '역할 변경', message, confirmLabel: '변경', tone: role === 'owner' ? 'danger' : undefined }))) return;
    await run(() => membersApi.setRole(api, organizationId, member.user_id, role), '역할을 바꿨습니다.', '역할을 바꾸지 못했습니다.');
  }

  async function remove(member: Member) {
    const message = `${memberLabel(member)}을(를) 이 매장에서 제거합니다. 제거하면 이 매장 데이터에 접근할 수 없습니다.`;
    if (!(await confirm({ title: '구성원 제거', message, confirmLabel: '제거', tone: 'danger' }))) return;
    await run(() => membersApi.remove(api, organizationId, member.user_id), '구성원을 제거했습니다.', '구성원을 제거하지 못했습니다.');
  }

  const memberLabel = (member: Member) => member.display_name || privacy.email(member.email) || '이 구성원';

  if (!canManage) return <section className="members-page"><p className="empty-state">구성원 관리는 소유자와 관리자만 사용할 수 있습니다.</p></section>;
  return (
    <section className="members-page">
      <div className="page-toolbar"><div><h1>구성원</h1><p className="muted">이미 가입한 사용자의 이메일로 구성원을 추가하고, 역할을 바꾸거나 제거합니다.</p></div></div>
      <AddMemberForm actorRole={currentRole} busy={busy} onAdd={(email, role) => run(() => membersApi.add(api, organizationId, email, role), '구성원을 추가했습니다.', '구성원을 추가하지 못했습니다.')} />
      {loadError && <ErrorState message={loadError} onRetry={() => void load()} />}
      {!loadError && members === null && <LoadingState />}
      {members && (
        <div className="data-surface members-table">
          <table>
            <thead><tr><th>이메일</th><th>표시 이름</th><th>역할</th><th>가입일</th><th aria-label="작업" /></tr></thead>
            <tbody>
              {members.map((member) => (
                <MemberRow key={member.user_id} member={member} self={member.user_id === currentUserId} abilities={memberAbilities(actor, member, members)} busy={busy}
                  email={privacy.email(member.email)} onRole={(role) => void changeRole(member, role)} onRemove={() => void remove(member)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface AddMemberFormProps {
  actorRole: Role;
  busy: boolean;
  /** 성공하면 true 를 돌려주며, 그때만 입력을 비운다. */
  onAdd: (email: string, role: Role) => Promise<boolean>;
}

function AddMemberForm({ actorRole, busy, onAdd }: AddMemberFormProps) {
  const roles = addableRoles(actorRole);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!EMAIL_PATTERN.test(value)) { setError('이메일 형식을 확인해 주세요.'); return; }
    setError('');
    if (await onAdd(value, role)) setEmail('');
  }
  return (
    <form className="members-add editor-panel" noValidate onSubmit={(event) => void submit(event)}>
      <label>가입한 사용자의 이메일<input type="email" value={email} onChange={(event) => setEmail(event.currentTarget.value)} placeholder="name@example.com" autoComplete="off" /></label>
      <label>역할<Select<Role> aria-label="추가할 역할" value={role} onChange={setRole} options={roles.map((value) => ({ value, label: ROLE_LABELS[value] }))} /></label>
      <button type="submit" className="primary-button" disabled={busy}>구성원 추가</button>
      {error && <p role="alert" className="form-error">{error}</p>}
      <p className="muted members-add__hint">상대방이 먼저 앱에 가입해 있어야 합니다. 가입하지 않았다면 가입 후 다시 시도해 주세요.</p>
    </form>
  );
}

interface MemberRowProps {
  member: Member;
  self: boolean;
  abilities: ReturnType<typeof memberAbilities>;
  busy: boolean;
  email: string;
  onRole: (role: Role) => void;
  onRemove: () => void;
}

function MemberRow({ member, self, abilities, busy, email, onRole, onRemove }: MemberRowProps) {
  const { changeRole, remove } = abilities;
  return (
    <tr>
      <td title={email}>{email || '-'}{self && <em className="members-self">나</em>}</td>
      <td>{member.display_name || '-'}</td>
      <td>
        <Select<Role>
          aria-label={`${member.email ?? member.display_name ?? '구성원'} 역할`} value={member.role} disabled={busy || !changeRole.allowed} title={changeRole.reason}
          onChange={onRole} options={ROLES.map((value) => ({ value, label: ROLE_LABELS[value] }))}
        />
      </td>
      <td>{kstDateKey(member.joined_at) || '-'}</td>
      <td><button type="button" className="danger-button" disabled={busy || !remove.allowed} title={remove.reason} onClick={onRemove}>제거</button></td>
    </tr>
  );
}
