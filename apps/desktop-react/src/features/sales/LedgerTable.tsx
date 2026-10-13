import { useState } from 'react';
import { formatWon, centsToText } from './format';
import { nextLedgerSort, typeLabel, type LedgerSort, type LedgerSortKey, type LedgerSummary } from './ledger';
import type { Transaction } from './types';

const headers: Array<{ key: LedgerSortKey; label: string }> = [
  { key: 'transaction_date', label: '거래일' }, { key: 'transaction_type', label: '유형' }, { key: 'amount', label: '금액' },
  { key: 'category', label: '분류' }, { key: 'counterparty', label: '거래처' }, { key: 'is_archived', label: '상태' },
];

interface TableProps {
  rows: Transaction[];
  sort: LedgerSort;
  onSort: (sort: LedgerSort) => void;
  selectedId: string | null;
  onSelect: (row: Transaction) => void;
  /** 마감된 달(YYYY-MM) 모음. 해당 달 거래에는 ‘월 마감’ 표시를 붙인다. */
  closedMonths: ReadonlySet<string>;
  emptyText: string;
}

/** 거래 목록 표. 머리글을 눌러 정렬하고, 행의 거래일을 눌러 선택한다. */
export function LedgerTable({ rows, sort, onSort, selectedId, onSelect, closedMonths, emptyText }: TableProps) {
  const ariaSort = (key: LedgerSortKey) => (sort.key === key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
  return <div className="data-surface finance-table">
    <table><caption>거래 내역</caption>
      <thead><tr>{headers.map((header) => <th key={header.key} aria-sort={ariaSort(header.key)}>
        <button type="button" className="sales-link history-sort" onClick={() => onSort(nextLedgerSort(sort, header.key))}>{header.label}{sort.key === header.key ? (sort.direction === 'asc' ? ' ▲' : ' ▼') : ''}</button>
      </th>)}</tr></thead>
      <tbody>{rows.map((row) => <tr key={row.id} className={row.id === selectedId ? 'is-selected' : ''}>
        <td><button type="button" className="sales-link" onClick={() => onSelect(row)}>{row.transaction_date}</button></td>
        <td>{typeLabel[row.transaction_type]}</td><td>{formatWon(row.amount)}</td><td title={row.category}>{row.category}</td><td title={row.counterparty}>{row.counterparty}</td>
        <td>{[row.is_archived ? '보관' : '', closedMonths.has(row.transaction_date.slice(0, 7)) ? '월 마감' : ''].filter(Boolean).join(' · ')}</td>
      </tr>)}</tbody>
    </table>
    {rows.length === 0 && <p className="empty-state">{emptyText}</p>}
  </div>;
}

/** 지금 표에 보이는 거래의 유형별·분류별 합계(보관 거래 제외). 서버의 기간 합계와는 다를 수 있다. */
export function LedgerTotals({ summary, filtered }: { summary: LedgerSummary; filtered: boolean }) {
  const [open, setOpen] = useState(false);
  return <div className="ledger-totals">
    <p className="ledger-groups" data-testid="ledger-visible-totals">
      <strong>{filtered ? '검색 결과 합계' : '표시 중인 거래 합계'}(보관 제외)</strong>
      <span>수입 {formatWon(centsToText(summary.income))} ({summary.incomeCount}건)</span>
      <span>지출 {formatWon(centsToText(summary.expense))} ({summary.expenseCount}건)</span>
      <span>순액 {formatWon(centsToText(summary.net))}</span>
    </p>
    {summary.byCategory.length > 0 && <div className="ledger-categories">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? '분류별 합계 닫기' : `분류별 합계 보기 (${summary.byCategory.length}개)`}</button>
      {open && <>
      <div className="data-surface ledger-categories__table"><table><caption>분류별 합계</caption>
        <thead><tr><th>분류</th><th>수입</th><th>지출</th><th>건수</th></tr></thead>
        <tbody>{summary.byCategory.map((group) => <tr key={group.category}>
          <td title={group.category}>{group.category}</td><td>{formatWon(centsToText(group.income))}</td><td>{formatWon(centsToText(group.expense))}</td><td>{group.count}</td>
        </tr>)}</tbody>
      </table></div>
      </>}
    </div>}
  </div>;
}
