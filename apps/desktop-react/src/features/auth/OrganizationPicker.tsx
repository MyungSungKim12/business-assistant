import type { Organization } from '../../api/schemas';
export function OrganizationPicker({ organizations, onSelect }: { organizations: Organization[]; onSelect: (organization: Organization) => void }) {
  return <main className="center-layout"><section className="picker-card"><p className="eyebrow">WORKSPACE</p><h1>매장 선택</h1><p className="muted">업무를 시작할 매장을 선택하세요.</p><div className="organization-list">{organizations.map((org) => <button key={org.id} onClick={() => onSelect(org)}><strong>{org.name}</strong><span>{org.role}</span></button>)}</div></section></main>;
}
