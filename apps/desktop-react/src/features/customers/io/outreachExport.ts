import type { ExportColumn } from '../../../lib/io/exportTable';
import type { BirthdayCustomer, LapsedCustomer } from '../insights';

/**
 * 연락 대상 내보내기 열(CRM-13). 문자·알림톡 발송이나 전화 안내에 쓸 명단이다.
 * "마케팅 수신" 열에 고객 정보의 수신 동의 여부(동의/미동의)를 넣으므로, 광고성 연락은 '동의' 행에만 보낸다.
 */
const consentText = (consent: boolean | undefined) => (consent ? '동의' : '미동의');

export const lapsedExportColumns: ExportColumn<LapsedCustomer>[] = [
  { header: '이름', width: 16, value: (row) => row.customer.name },
  { header: '연락처', width: 16, value: (row) => row.customer.phone },
  { header: '마지막 방문일', type: 'date', width: 14, value: (row) => row.lastVisit },
  { header: '경과 일수', type: 'number', width: 10, value: (row) => row.days },
  { header: '다음 방문일', type: 'date', width: 14, value: (row) => row.customer.next_visit_date },
  { header: '태그', width: 20, value: (row) => row.customer.tags.join(', ') },
  { header: '메모', width: 36, value: (row) => row.customer.notes },
  { header: '마케팅 수신', width: 12, value: (row) => consentText(row.customer.marketing_consent) },
];

export const birthdayExportColumns: ExportColumn<BirthdayCustomer>[] = [
  { header: '이름', width: 16, value: (row) => row.customer.name },
  { header: '연락처', width: 16, value: (row) => row.customer.phone },
  { header: '생일', type: 'date', width: 14, value: (row) => row.birthDate },
  { header: '마지막 방문일', type: 'date', width: 14, value: (row) => row.customer.last_visit_date },
  { header: '태그', width: 20, value: (row) => row.customer.tags.join(', ') },
  { header: '마케팅 수신', width: 12, value: (row) => consentText(row.customer.marketing_consent) },
];
