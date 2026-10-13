import { DataGrid, type Column } from '@business-assistant/react-ui';
import { useMemo } from 'react';
import { usePrivacy, type Privacy } from '../../lib/privacy';
import type { Customer } from './types';

/** 연락처는 개인정보 표시 옵션(전화번호 가림)을 따른다. 검색과 저장 값은 원본 그대로다. */
const buildColumns = (privacy: Privacy): Column<Customer>[] => [
  { key: 'name', header: '고객명', value: (c) => c.name },
  { key: 'phone', header: '연락처', value: (c) => privacy.phone(c.phone) || '-' },
  { key: 'tags', header: '태그', value: (c) => c.tags.join(', ') || '-' },
  { key: 'last', header: '최근 방문', value: (c) => c.last_visit_date ?? '-' },
];

type Props = { customers: Customer[]; selectedId?: string; loading?: boolean; onSelect: (customer: Customer) => void };

export function CustomerGrid({ customers, selectedId, loading, onSelect }: Props) {
  const privacy = usePrivacy();
  const columns = useMemo(() => buildColumns(privacy), [privacy]);
  return (
    <DataGrid columns={columns} rows={customers} rowKey={(c) => c.id} selectedKey={selectedId} onSelect={onSelect} onActivate={onSelect}
      loading={loading} emptyText="조건에 맞는 고객이 없습니다." ariaLabel="고객 목록" storageKey="customer-grid" numbered />
  );
}
