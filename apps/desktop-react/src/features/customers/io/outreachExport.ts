import type { ExportColumn } from '../../../lib/io/exportTable';
import type { BirthdayCustomer, LapsedCustomer } from '../insights';

/**
 * 연락 대상 내보내기 열(CRM-13). 문자·알림톡 발송이나 전화 안내에 쓸 명단이다.
 * 마케팅 수신 동의는 아직 앱에 기록하지 않으므로, 광고성 연락 전에는 동의 여부를 직접 확인해야 한다(마지막 열 안내).
 */
const CONSENT_NOTE = '수신 동의 확인 필요';

export const lapsedExportColumns: ExportColumn<LapsedCustomer>[] = [
  { header: '이름', width: 16, value: (row) => row.customer.name },
  { header: '연락처', width: 16, value: (row) => row.customer.phone },
  { header: '마지막 방문일', type: 'date', width: 14, value: (row) => row.lastVisit },
  { header: '경과 일수', type: 'number', width: 10, value: (row) => row.days },
  { header: '다음 방문일', type: 'date', width: 14, value: (row) => row.customer.next_visit_date },
  { header: '태그', width: 20, value: (row) => row.customer.tags.join(', ') },
  { header: '메모', width: 36, value: (row) => row.customer.notes },
  { header: '안내', width: 18, value: () => CONSENT_NOTE },
];

export const birthdayExportColumns: ExportColumn<BirthdayCustomer>[] = [
  { header: '이름', width: 16, value: (row) => row.customer.name },
  { header: '연락처', width: 16, value: (row) => row.customer.phone },
  { header: '생일', type: 'date', width: 14, value: (row) => row.birthDate },
  { header: '마지막 방문일', type: 'date', width: 14, value: (row) => row.customer.last_visit_date },
  { header: '태그', width: 20, value: (row) => row.customer.tags.join(', ') },
  { header: '안내', width: 18, value: () => CONSENT_NOTE },
];
