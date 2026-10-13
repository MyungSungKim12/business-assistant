import type { Organization } from '../../api/schemas';
import { OrganizationCreateForm } from './OrganizationCreateForm';

interface Props {
  organizations: Organization[];
  onSelect: (organization: Organization) => void;
  /** 있으면 새 매장 만들기 양식을 함께 보여 준다. */
  onCreate?: (name: string, slug: string) => Promise<boolean>;
}

export function OrganizationPicker({ organizations, onSelect, onCreate }: Props) {
  return (
    <main className="center-layout">
      <section className="picker-card">
        <p className="eyebrow">WORKSPACE</p>
        <h1>매장 선택</h1>
        <p className="muted">업무를 시작할 매장을 선택하세요.</p>
        <div className="organization-list">
          {organizations.map((org) => <button key={org.id} onClick={() => onSelect(org)}><strong>{org.name}</strong><span>{org.role}</span></button>)}
        </div>
        {onCreate && <OrganizationCreateForm onCreate={onCreate} />}
      </section>
    </main>
  );
}
