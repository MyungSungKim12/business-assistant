import type { ExportColumn } from '../../../lib/io/exportTable';
import type { Customer } from '../types';
import { FIELD_LABEL } from './fields';
import type { PlanRow } from './plan';

const statusLabel = (status: string) => (status === 'active' ? '활성' : status === 'archived' ? '보관' : status);

/** 고객 내보내기 열. 머리글은 가져오기 자동 매핑이 그대로 인식하는 이름이다(내보낸 파일을 다시 가져올 수 있다). */
export const customerExportColumns: ExportColumn<Customer>[] = [
  { header: FIELD_LABEL.name, width: 16, value: (row) => row.name },
  { header: FIELD_LABEL.phone, width: 16, value: (row) => row.phone },
  { header: FIELD_LABEL.email, width: 26, value: (row) => row.email },
  { header: FIELD_LABEL.tags, width: 24, value: (row) => row.tags.join(', ') },
  { header: FIELD_LABEL.status, width: 8, value: (row) => statusLabel(row.status) },
  { header: FIELD_LABEL.skin_type, width: 12, value: (row) => row.skin_type },
  { header: FIELD_LABEL.birth_date, type: 'date', width: 12, value: (row) => row.birth_date },
  { header: FIELD_LABEL.last_visit_date, type: 'date', width: 12, value: (row) => row.last_visit_date },
  { header: FIELD_LABEL.next_visit_date, type: 'date', width: 12, value: (row) => row.next_visit_date },
  { header: FIELD_LABEL.concerns, width: 24, value: (row) => row.concerns.join(', ') },
  { header: FIELD_LABEL.allergies, width: 20, value: (row) => row.allergies },
  { header: FIELD_LABEL.notes, width: 40, value: (row) => row.notes },
];

/** 빈 양식에 넣는 예시 1행(실제 고객 정보가 아니다). */
export const templateExample = {
  name: '홍길동', phone: '010-1234-5678', email: 'gildong@example.com', tags: 'VIP, 재방문', status: '활성', skin_type: '복합성',
  birth_date: '1990-05-21', last_visit_date: '2026-01-15', next_visit_date: '2026-02-15', concerns: '건조함, 홍조', allergies: '없음', notes: '예시 행입니다. 지우고 사용하세요.',
};

export const customerTemplateColumns: ExportColumn<typeof templateExample>[] = [
  { header: FIELD_LABEL.name, width: 16, value: (row) => row.name },
  { header: FIELD_LABEL.phone, width: 16, value: (row) => row.phone },
  { header: FIELD_LABEL.email, width: 26, value: (row) => row.email },
  { header: FIELD_LABEL.tags, width: 24, value: (row) => row.tags },
  { header: FIELD_LABEL.status, width: 8, value: (row) => row.status },
  { header: FIELD_LABEL.skin_type, width: 12, value: (row) => row.skin_type },
  { header: FIELD_LABEL.birth_date, type: 'date', width: 12, value: (row) => row.birth_date },
  { header: FIELD_LABEL.last_visit_date, type: 'date', width: 12, value: (row) => row.last_visit_date },
  { header: FIELD_LABEL.next_visit_date, type: 'date', width: 12, value: (row) => row.next_visit_date },
  { header: FIELD_LABEL.concerns, width: 24, value: (row) => row.concerns },
  { header: FIELD_LABEL.allergies, width: 20, value: (row) => row.allergies },
  { header: FIELD_LABEL.notes, width: 40, value: (row) => row.notes },
];

/** 오류·실패 행 내려받기: 원본 열 그대로 + 행 번호와 사유. */
export function problemColumns(headers: readonly string[]): ExportColumn<{ row: PlanRow; reason: string }>[] {
  return [
    { header: '원본 행', type: 'number', value: (item) => item.row.sourceRow },
    { header: '사유', width: 40, value: (item) => item.reason },
    ...headers.map((header, index) => ({ header: header || `열 ${index + 1}`, value: (item: { row: PlanRow; reason: string }) => item.row.cells[index] ?? '' })),
  ];
}
