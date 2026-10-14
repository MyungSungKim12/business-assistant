import { useMemo, type ReactNode } from 'react';
import { birthdayCustomers, lapsedCustomers, LAPSED_DAYS, newThisMonth, recentlyRegistered, summarizeCustomers, UPCOMING_DAYS, upcomingVisits } from './insights';
import { ExportButton } from '../../lib/io/ExportButton';
import { birthdayExportColumns, lapsedExportColumns } from './io/outreachExport';
import { kstToday } from './kst';
import type { Customer } from './types';

type Props = {
  customers: Customer[];
  selectedId?: string;
  /** 테스트에서 기준 시각을 고정할 때 쓴다. */
  now?: Date;
  /** 전체 고객이 아니라 불러온 일부만으로 계산했을 때의 안내 문구(예: '불러온 200명 기준'). 없으면 표시하지 않는다. */
  scopeNote?: string;
  onSelect: (customer: Customer) => void;
};

type ListItem = { customer: Customer; detail: string; strong?: boolean };

function Card({ title, count, hint, wide, action, children }: { title: string; count?: number; hint?: string; wide?: boolean; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={wide ? 'cx-insight cx-insight--wide' : 'cx-insight'} aria-label={title}>
      <header>
        <h3>{title}</h3>
        {count !== undefined && <span className="cx-badge">{count}</span>}
        {hint && <span className="muted cx-insight__hint">{hint}</span>}
        {action}
      </header>
      <div className="cx-insight__body">{children}</div>
    </section>
  );
}

function CustomerList({ items, selectedId, empty, onSelect }: { items: ListItem[]; selectedId?: string; empty: string; onSelect: (customer: Customer) => void }) {
  if (items.length === 0) return <p className="cx-insight__empty muted">{empty}</p>;
  return (
    <ul className="cx-insight__list">
      {items.map(({ customer, detail, strong }) => (
        <li key={customer.id}>
          <button type="button" aria-pressed={customer.id === selectedId} onClick={() => onSelect(customer)}>
            <span className="cx-insight__name">{customer.name}</span>
            <span className={strong ? 'cx-insight__detail cx-insight__detail--strong' : 'cx-insight__detail'}>{detail}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

const dayLabel = (days: number) => (days === 0 ? '오늘' : `D-${days}`);

/** 고객 목록 데이터만으로 계산하는 업무 인사이트(현황·다음 방문·장기 미방문·생일). 기준일은 KST. */
export function InsightsPanel({ customers, selectedId, now, scopeNote, onSelect }: Props) {
  const today = kstToday(now);
  const summary = useMemo(() => summarizeCustomers(customers, today), [customers, today]);
  const upcoming = useMemo(() => upcomingVisits(customers, today), [customers, today]);
  const lapsed = useMemo(() => lapsedCustomers(customers, today), [customers, today]);
  const birthdays = useMemo(() => birthdayCustomers(customers, today), [customers, today]);
  const newCustomers = useMemo(() => newThisMonth(customers, today), [customers, today]);
  const recent = useMemo(() => recentlyRegistered(customers), [customers]);
  const maxTag = summary.topTags[0]?.count ?? 1;
  const month = Number(today.slice(5, 7));

  return (
    <div className="cx-insights" aria-label="고객 인사이트">
      <Card title="고객 현황" hint={`${today} 기준`}>
        <dl className="cx-stats">
          <div><dt>전체</dt><dd>{summary.total}</dd></div>
          <div><dt>활성</dt><dd>{summary.active}</dd></div>
          <div><dt>VIP</dt><dd>{summary.vip}</dd></div>
          <div><dt>보관</dt><dd>{summary.archived}</dd></div>
          {newCustomers.count === null
            ? <div><dt>이번 달 방문</dt><dd>{summary.visitedThisMonth}</dd></div>
            : <div><dt>이번 달 신규</dt><dd>{newCustomers.count}</dd></div>}
        </dl>
        {scopeNote && <p className="cx-insight__scope muted">{scopeNote}</p>}
        <h4>태그별 분포 (상위 {summary.topTags.length || 5})</h4>
        {summary.topTags.length === 0
          ? <p className="cx-insight__empty muted">등록된 태그가 없습니다.</p>
          : <ul className="cx-tags">{summary.topTags.map((item) => (
              <li key={item.tag}><span title={item.tag}>{item.tag}</span><i style={{ width: `${Math.max(6, (item.count / maxTag) * 100)}%` }} /><b>{item.count}</b></li>
            ))}</ul>}
      </Card>
      <Card title="다음 방문 임박" count={upcoming.length} hint={`${UPCOMING_DAYS}일 이내`}>
        <CustomerList selectedId={selectedId} onSelect={onSelect} empty={`${UPCOMING_DAYS}일 안에 예정된 방문이 없습니다.`}
          items={upcoming.map((item) => ({ customer: item.customer, detail: `${item.date} · ${dayLabel(item.days)}`, strong: item.days <= 1 }))} />
      </Card>
      <Card title="장기 미방문" count={lapsed.length} hint={`${LAPSED_DAYS}일 이상 · 연락 대상`}
        action={lapsed.length > 0 ? <ExportButton title="장기 미방문 연락 대상" label="명단 내보내기" columns={lapsedExportColumns} rows={lapsed} description="연락처가 있는 장기 미방문 고객 명단을 저장합니다. '마케팅 수신' 열이 '동의'인 고객에게만 광고성 문자를 보내세요." /> : undefined}>
        <CustomerList selectedId={selectedId} onSelect={onSelect} empty="연락이 필요한 장기 미방문 고객이 없습니다."
          items={lapsed.map((item) => ({ customer: item.customer, detail: item.days === null ? '방문 기록 없음' : `${item.lastVisit} · ${item.days}일 전` }))} />
      </Card>
      <Card title="이번 달 생일" count={birthdays.length} hint={`${month}월`}
        action={birthdays.length > 0 ? <ExportButton title="이번 달 생일 고객" label="명단 내보내기" columns={birthdayExportColumns} rows={birthdays} description="이번 달 생일인 고객 명단을 저장합니다. '마케팅 수신' 열이 '동의'인 고객에게만 광고성 문자를 보내세요." /> : undefined}>
        <CustomerList selectedId={selectedId} onSelect={onSelect} empty="이번 달 생일인 고객이 없습니다."
          items={birthdays.map((item) => ({ customer: item.customer, detail: `${month}월 ${item.day}일${item.isToday ? ' · 오늘' : ''}`, strong: item.isToday }))} />
      </Card>
      <Card title="최근 등록" count={recent.length} hint="등록일 순" wide>
        <CustomerList selectedId={selectedId} onSelect={onSelect} empty="등록일 정보가 있는 고객이 없습니다."
          items={recent.map((item) => ({ customer: item.customer, detail: item.createdDate }))} />
      </Card>
    </div>
  );
}
