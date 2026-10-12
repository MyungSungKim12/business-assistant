import { DataGrid, type Column } from '@business-assistant/react-ui';
import type { Customer } from './types';
const columns: Column<Customer>[] = [{ key: 'name', header: '고객명', value: (c) => c.name }, { key: 'phone', header: '연락처', value: (c) => c.phone ?? '-' }, { key: 'tags', header: '태그', value: (c) => c.tags.join(', ') || '-' }, { key: 'last', header: '최근 방문', value: (c) => c.last_visit_date ?? '-' }];
export function CustomerGrid({ customers, selectedId, onSelect }: { customers: Customer[]; selectedId?: string; onSelect: (customer: Customer) => void }) { return <DataGrid columns={columns} rows={customers} rowKey={(c) => c.id} selectedKey={selectedId} onSelect={onSelect} onActivate={onSelect} emptyText="조건에 맞는 고객이 없습니다." ariaLabel="고객 목록" storageKey="customer-grid"/>; }
