// 데모 데이터 정의와 단계(영역) 메타데이터. 모든 이름에는 [데모] 표식이 있고, 전화는 010-0000-xxxx, 이메일은 @example.com이다.
import { MARK, addDays, isoWeekday, kstToUtcZ } from './util.mjs';

/** 단계 실행 순서(= 의존 관계를 만족하는 위상 순서). */
export const STEP_ORDER = ['customers', 'tasks', 'staff', 'services', 'resources', 'requirements', 'appointments', 'treatments', 'saleDrafts', 'products', 'inventory', 'sales', 'closing', 'finance', 'templates', 'documents', 'consents', 'files'];

/** 시술 목표 상태별로 필요한 상태 전이 동작. */
export const TREATMENT_ACTIONS = {
  draft: [],
  consulted: ['consult'],
  in_progress: ['consult', 'start'],
  completed: ['consult', 'start', 'complete'],
  cancelled: ['consult', 'start', 'cancel'],
};

/** 각 단계의 설명, 선행 단계, 필요한 기능 키(없으면 건너뜀)와 예정 개수 계산. */
export const STEP_META = {
  customers: { label: '고객', needs: [], features: ['crm.basic'], counts: (p) => ({ 고객: p.customers.length }) },
  tasks: { label: '할 일', needs: [], features: ['task.basic'], counts: (p) => ({ 할일: p.tasks.length }) },
  staff: { label: '예약 담당자·근무시간·휴무', needs: [], features: ['task.basic'], counts: (p) => ({ 담당자: p.staff.length, 근무시간: p.staff.length, 휴무: p.timeOff.length }) },
  services: { label: '예약 서비스', needs: [], features: ['task.basic'], counts: (p) => ({ 서비스: p.services.length }) },
  resources: { label: '예약 공간·장비', needs: [], features: ['task.basic'], counts: (p) => ({ 공간: p.resources.filter((r) => r.kind === 'room').length, 장비: p.resources.filter((r) => r.kind === 'equipment').length }) },
  requirements: { label: '서비스별 필수 자원 기준', needs: ['services', 'resources'], features: ['task.basic'], counts: (p) => ({ 기준: p.services.length }) },
  appointments: { label: '예약(자원 선택·상태 전이)', needs: ['customers', 'staff', 'services', 'resources', 'requirements'], features: ['task.basic', 'crm.basic'], counts: (p) => ({ 예약: p.appointments.length, 상태전이: p.appointments.reduce((n, a) => n + a.chain.length, 0) }) },
  treatments: { label: '시술 기록(상담·시작·완료)', needs: ['customers'], features: ['crm.basic'], counts: (p) => ({ 시술: p.treatments.length, 상태전이: p.treatments.reduce((n, t) => n + TREATMENT_ACTIONS[t.target].length, 0) }) },
  saleDrafts: { label: '시술 판매 초안', needs: ['customers', 'treatments'], features: ['crm.basic', 'finance.basic', 'document.template'], counts: (p) => ({ 판매초안: p.saleDrafts.length }) },
  products: { label: '상품·회원권', needs: [], features: ['crm.basic', 'finance.basic'], counts: (p) => ({ 상품: p.products.filter((x) => x.kind === 'product').length, 회원권: p.products.filter((x) => x.kind === 'membership').length }) },
  inventory: { label: '입고·재고 조정', needs: ['products'], features: ['crm.basic', 'finance.basic'], counts: (p) => ({ 입고: p.products.filter((x) => x.kind === 'product').length, 재고조정: p.stockAdjustments.length }) },
  sales: { label: '방문·장바구니·할인·수납·환불·반품·회원권 지갑', needs: ['customers', 'treatments', 'saleDrafts', 'products', 'inventory'], features: ['crm.basic', 'finance.basic'], counts: (p) => ({ 방문흐름: p.flows.length }) },
  closing: { label: '일 마감(과거 영업일)', needs: [], features: ['finance.basic'], counts: () => ({ 일마감: 1 }) },
  finance: { label: '수입·지출', needs: [], features: ['finance.basic'], counts: (p) => ({ 거래: p.finance.length }) },
  templates: { label: '문서 서식 생성·발행', needs: [], features: ['document.template'], counts: (p) => ({ 서식: p.templates.length, 발행: p.templates.filter((t) => t.publish).length }) },
  documents: { label: '문서', needs: ['templates'], features: ['document.template'], counts: (p) => ({ 문서: p.documents.length }) },
  consents: { label: '시술 문서 발행·동의서 서명', needs: ['customers', 'treatments', 'templates'], features: ['crm.basic', 'document.template'], counts: (p) => ({ 시술문서: p.consents.length, 서명: p.consents.filter((c) => c.sign).length, 교부: p.consents.filter((c) => c.deliver).length }) },
  files: { label: '파일 자료', needs: [], features: ['files.basic'], counts: (p) => ({ 파일: p.files.length }) },
};

/** 선택한 영역에 선행 단계를 자동으로 더하고 실행 순서대로 돌려준다. */
export function resolveSteps(only) {
  const wanted = new Set(only && only.length ? only : STEP_ORDER);
  const visit = (key) => { for (const need of STEP_META[key].needs) { if (!wanted.has(need)) { wanted.add(need); visit(need); } } };
  for (const key of [...wanted]) visit(key);
  return STEP_ORDER.filter((key) => wanted.has(key));
}

const customerRows = [
  ['김서연', '1992-03-14', '복합성', ['모공', '피지'], '', ['VIP', '단골'], -12, 10],
  ['이민지', '1988-07-02', '건성', ['건조', '주름'], '라텍스', ['신규'], -3, 14],
  ['박지훈', '1995-11-21', '지성', ['여드름', '피지'], '', ['남성', '여드름관리'], -21, null],
  ['최유진', '1990-01-30', '민감성', ['홍조', '민감'], '니켈', ['민감주의', '재방문'], -7, 21],
  ['정하늘', '1985-09-09', '중성', ['탄력', '미백'], '', ['프로모션'], -40, null],
  ['강도윤', '1998-05-18', '지성', ['블랙헤드'], '', ['신규', '학생'], -2, 7],
  ['조은서', '1993-12-25', '건성', ['각질', '건조'], '', ['단골', '회원권'], -15, 30],
  ['윤재호', '1980-04-07', '복합성', ['색소', '잡티'], '아스피린 민감', ['VIP'], -30, 5],
  ['한소희', '1997-08-16', '민감성', ['트러블'], '', ['소개'], -9, 18],
  ['오세진', '1991-02-11', '중성', ['기미'], '', ['재방문', '프로모션'], -5, 25],
];

const staffRows = [
  ['박지민 실장', '10:00', '19:00'], ['김하은 원장', '10:00', '19:00'], ['이서준 매니저', '11:00', '20:00'], ['최수아 디자이너', '10:00', '19:00'], ['정다은 테라피스트', '10:00', '19:00'],
  ['강민재 매니저', '11:00', '20:00'], ['윤서아 테라피스트', '10:00', '19:00'], ['장하준 스태프', '10:00', '19:00'], ['임채원 스태프', '10:00', '19:00'], ['한지우 인턴', '10:00', '19:00'],
];

const serviceRows = [
  ['기본 피부 관리', 60, 10, false], ['수분 집중 관리', 70, 10, false], ['여드름 클리닉', 50, 10, true], ['레이저 토닝', 40, 15, true], ['모공 딥클렌징', 60, 10, true],
  ['보습 앰플 케어', 45, 5, false], ['LED 광 테라피', 30, 5, true], ['바디 릴렉스 마사지', 90, 15, false], ['두피 스케일링', 60, 10, true], ['눈썹 정리·왁싱', 30, 5, false],
];

const appointmentRows = [
  // [고객, 담당자, 서비스, 날짜 오프셋, 시각, 경로, 상태 전이, 취소 사유]
  [6, 0, 0, -5, '11:00', 'phone', ['confirmed', 'checked_in', 'completed']],
  [7, 1, 2, -4, '13:30', 'online', ['confirmed', 'checked_in', 'completed']],
  [0, 2, 1, -3, '14:00', 'manual', ['no_show']],
  [1, 3, 3, -2, '11:30', 'walk_in', ['canceled'], '고객 개인 사정으로 취소 요청'],
  [8, 4, 4, -1, '15:00', 'manual', ['confirmed', 'checked_in']],
  [2, 5, 5, 1, '11:00', 'phone', ['confirmed']],
  [3, 6, 6, 2, '12:00', 'online', ['confirmed']],
  [4, 7, 7, 3, '13:00', 'manual', []],
  [5, 8, 8, 4, '14:30', 'phone', []],
  [9, 9, 9, 5, '16:00', 'online', ['canceled'], '일정 변경으로 취소'],
];

const treatmentRows = [
  // [이름, 분류, 시술자, 금액, 날짜 오프셋, 다음 방문 오프셋, 목표]
  ['기본 피부 관리 1회', '피부관리', '박지민 실장', 120000, -12, 10, 'completed'],
  ['수분 집중 관리', '피부관리', '김하은 원장', 80000, -10, 14, 'completed'],
  ['여드름 클리닉', '클리닉', '이서준 매니저', 90000, -9, null, 'completed'],
  ['레이저 토닝', '레이저', '최수아 디자이너', 150000, -8, 20, 'completed'],
  ['모공 딥클렌징', '클리닉', '정다은 테라피스트', 70000, -7, null, 'completed'],
  ['탄력 리프팅 케어', '리프팅', '강민재 매니저', 200000, -6, 30, 'completed'],
  ['LED 광 테라피', '광테라피', '윤서아 테라피스트', 60000, -5, null, 'cancelled'],
  ['바디 릴렉스 마사지', '바디', '장하준 스태프', 100000, -1, null, 'in_progress'],
  ['두피 스케일링', '두피', '임채원 스태프', 55000, -1, null, 'consulted'],
  ['눈썹 정리·왁싱', '왁싱', '한지우 인턴', 30000, 0, null, 'draft'],
];

const productRows = [
  ['DEMO-P01', '수분 크림 50ml', 'product', '개', 25000, 0, 0, null],
  ['DEMO-P02', '진정 토너 200ml', 'product', '개', 18000, 0, 0, null],
  ['DEMO-P03', '선크림 SPF50', 'product', '개', 22000, 0, 0, null],
  ['DEMO-P04', '클렌징 폼', 'product', '개', 12000, 0, 0, null],
  ['DEMO-P05', '비타민 앰플', 'product', '개', 38000, 0, 0, null],
  ['DEMO-P06', '시트 마스크 팩(5매)', 'product', '세트', 15000, 0, 0, null],
  ['DEMO-P07', '아이 크림 30ml', 'product', '개', 45000, 0, 0, null],
  ['DEMO-M01', '선불 관리권 30만원(33만원 충전)', 'membership', '권', 300000, 330000, 0, 365],
  ['DEMO-M02', '피부관리 5회권', 'membership', '권', 350000, 0, 5, 180],
  ['DEMO-M03', '레이저 토닝 패키지(10만원권)', 'membership', '권', 100000, 110000, 0, 90],
];

const financeRows = [
  ['expense', 1500000, 28, '임차료', '건물주'], ['expense', 2400000, 25, '인건비', '직원 급여'], ['expense', 320000, 21, '재료비', '화장품 도매'],
  ['expense', 150000, 18, '광고비', 'SNS 광고'], ['income', 80000, 15, '기타 수입', '제휴 수수료'], ['expense', 180000, 12, '공과금', '전기·수도'],
  ['income', 260000, 9, '제품 판매', '온라인 스토어'], ['expense', 95000, 6, '소모품', '일회용품'], ['income', 400000, 4, '강의·교육', '외부 강의'], ['expense', 120000, 1, '장비 유지보수', '장비 업체'],
];

const templateRows = [
  ['시술 동의서', '시술 전 설명과 동의를 기록하는 서식', '{{customer.name}} 고객님은 {{treatment.date}}에 시행되는 "{{treatment.name}}" 시술의 효과, 발생 가능한 반응, 주의사항에 대한 설명을 들었으며 이에 동의합니다.\n담당자: {{treatment.practitioner}}', true],
  ['시술 후 주의사항 안내문', '시술 후 관리 방법 안내', '{{customer.name}} 고객님, {{treatment.date}} "{{treatment.name}}" 시술 후 24시간 동안 사우나와 격한 운동을 피해 주세요. 자외선 차단제를 꼭 바르세요.\n담당자: {{treatment.practitioner}}', true],
  ['개인정보 수집·이용 동의서', '고객 정보 수집·이용 동의', '{{customer.name}}({{customer.phone}}, 생년월일 {{customer.birth_date}}) 님은 상담·예약 안내를 위한 개인정보 수집·이용에 동의합니다.', true],
  ['환불 규정 안내(작성 중)', '아직 발행하지 않은 초안 서식', '환불 규정 초안입니다. 내용은 확정 후 발행합니다.', false],
];

const documentRows = [
  ['매장 운영 안내문', 'draft', null], ['신규 고객 환영 안내', 'draft', null], ['예약 변경·취소 규정', 'final', null], ['시술 동의서 샘플(김서연)', 'final', 0], ['시술 동의서 샘플(이민지)', 'draft', 0],
  ['시술 후 주의사항 샘플', 'final', 1], ['개인정보 동의서 샘플', 'final', 2], ['월간 이벤트 안내', 'draft', null], ['장비 점검 체크리스트', 'final', null], ['지난 분기 프로모션 안내', 'archived', null],
];

const fileRows = [
  ['안내문_01.txt', 'text/plain'], ['안내문_02.txt', 'text/plain'], ['매장규정_03.txt', 'text/plain'], ['시술순서_04.txt', 'text/plain'], ['이벤트공지_05.txt', 'text/plain'],
  ['고객목록_샘플.csv', 'text/csv'], ['상품가격표_샘플.csv', 'text/csv'], ['재고현황_샘플.csv', 'text/csv'], ['월간매출_샘플.csv', 'text/csv'], ['점검기록_06.txt', 'text/plain'],
];

/**
 * 한국 시간 기준 오늘로부터 날짜를 계산해 시드 계획 전체를 만든다.
 * 예약 날짜는 일요일(근무 없음)과 서로 겹침을 피해 고른다.
 */
export function buildPlan(today) {
  const customers = customerRows.map(([name, birth, skin, concerns, allergies, tags, last, next], index) => ({
    name: `${MARK} ${name}`,
    body: {
      name: `${MARK} ${name}`, email: `demo${String(index + 1).padStart(2, '0')}@example.com`, phone: `010-0000-${String(index + 1).padStart(4, '0')}`,
      notes: '데모 데이터입니다. 실제 고객이 아닙니다.', birth_date: birth, skin_type: skin, concerns, allergies, tags,
      last_visit_date: addDays(today, last), next_visit_date: next === null ? null : addDays(today, next), status: 'active',
    },
  }));

  const taskRows = [
    ['신규 고객 환영 문자 발송', 'normal', 'open', 1], ['재고 실사 일정 확인', 'high', 'in_progress', 2], ['레이저 장비 점검 예약', 'high', 'open', 3], ['이번 달 마감 정산 확인', 'high', 'open', 5],
    ['회원권 만료 예정 고객 안내', 'normal', 'in_progress', 7], ['시술 동의서 서식 갱신 검토', 'low', 'open', 10], ['지난 주 예약 취소 고객 연락', 'normal', 'done', -2],
    ['인스타그램 이벤트 게시물 작성', 'low', 'done', -5], ['직원 근무표 확정', 'normal', 'done', -1], ['구형 장비 폐기 신청', 'low', 'canceled', -3],
  ];
  const tasks = taskRows.map(([title, priority, status, due]) => ({ title: `${MARK} ${title}`, status, body: { title: `${MARK} ${title}`, description: '데모 데이터입니다.', due_at: kstToUtcZ(addDays(today, due), '18:00'), priority } }));

  const workWeek = [1, 2, 3, 4, 5, 6];
  const staff = staffRows.map(([name, start, end]) => ({ name: `${MARK} ${name}`, hours: workWeek.map((weekday) => ({ weekday, start, end })) }));
  const timeOff = [
    { staffIndex: 2, date: addDays(today, 14), start: '10:00', end: '19:00', reason: `${MARK} 연차` },
    { staffIndex: 5, date: addDays(today, 15), start: '10:00', end: '19:00', reason: `${MARK} 연차` },
    { staffIndex: 8, date: addDays(today, 16), start: '10:00', end: '13:00', reason: `${MARK} 병원 방문` },
  ];
  const services = serviceRows.map(([name, duration, buffer, equipment]) => ({ name: `${MARK} ${name}`, duration_minutes: duration, buffer_minutes: buffer, requirements: equipment ? [{ kind: 'room', quantity: 1 }, { kind: 'equipment', quantity: 1 }] : [{ kind: 'room', quantity: 1 }] }));
  const resources = [
    ...[1, 2, 3, 4, 5].map((n) => ({ name: `${MARK} 관리실 ${n}`, kind: 'room' })),
    ...['레이저 장비 A', '고주파 장비 B', '초음파 스케일러 C', 'LED 마스크 D', '스티머 E'].map((name) => ({ name: `${MARK} ${name}`, kind: 'equipment' })),
  ];

  const used = new Set();
  const appointments = appointmentRows.map(([customer, staffIndex, service, offset, time, source, chain, reason], index) => {
    let date = addDays(today, offset);
    const step = offset < 0 ? -1 : 1;
    while (isoWeekday(date) === 7 || used.has(date)) date = addDays(date, step);
    used.add(date);
    return { index, customer, staff: staffIndex, service, date, time, source, chain, reason: reason ?? null };
  });

  const treatments = treatmentRows.map(([name, category, practitioner, amount, offset, next, target], index) => ({
    index, customer: index, target,
    body: { treatment_date: addDays(today, offset), treatment_name: `${MARK} ${name}`, category, practitioner, notes: '데모 데이터입니다.', amount: String(amount), next_visit_date: next === null ? null : addDays(today, next) },
  }));
  const saleDrafts = [0, 1, 3, 4, 5, 6].map((treatment) => {
    const t = treatments[treatment];
    const cancelled = t.target === 'cancelled';
    return {
      treatment,
      values: {
        description: t.body.treatment_name, amount: t.body.amount, consent_document_id: null,
        exception_reason: `${MARK} 서명 동의서를 연결하지 않은 데모 데이터`, partial_reason: cancelled ? `${MARK} 중단 전까지 제공한 부분 시술 비용` : '',
      },
    };
  });

  const products = productRows.map(([sku, name, kind, unit, price, benefitMoney, benefitCount, days]) => ({
    sku, name: `${MARK} ${name}`, kind,
    body: { sku, name: `${MARK} ${name}`, kind, unit_name: unit, sale_price: String(price), benefit_money: String(benefitMoney), benefit_count: benefitCount, valid_days: days, is_active: true },
  }));
  const receipts = { 'DEMO-P01': 40, 'DEMO-P02': 30, 'DEMO-P03': 25, 'DEMO-P04': 50, 'DEMO-P05': 20, 'DEMO-P06': 60, 'DEMO-P07': 15 };
  const stockAdjustments = [
    { sku: 'DEMO-P03', kind: 'disposal', quantity: 2, reason: `${MARK} 유통기한 임박 폐기` },
    { sku: 'DEMO-P04', kind: 'stocktake', quantity: 48, reason: `${MARK} 월말 재고 실사` },
    { sku: 'DEMO-P05', kind: 'supplier_return', quantity: 1, reason: `${MARK} 불량 반품` },
  ];

  // 수납 흐름. 같은 고객의 n번째 방문(예약과 연결되지 않은 방문)으로 완료 여부를 판단한다.
  const flows = [
    { key: 'f1', customer: 0, nth: 1, done: ['closed'], title: '시술 복합 수납(현금+카드) 후 일부 환불' },
    { key: 'f2', customer: 1, nth: 1, done: ['closed'], title: '시술 10% 할인 후 카드+계좌이체 수납' },
    { key: 'f3', customer: 2, nth: 1, done: ['closed'], title: '제품 2종 판매 후 1개 반품(재입고)' },
    { key: 'f4', customer: 3, nth: 1, done: ['closed'], title: '선불 관리권 판매(카드)로 고객 지갑 생성' },
    { key: 'f5', customer: 3, nth: 2, done: ['closed'], title: '지갑 금액 사용 + 현금 잔액 수납' },
    { key: 'f6a', customer: 4, nth: 1, done: ['closed'], title: '5회권 판매(현금)로 횟수 지갑 생성' },
    { key: 'f6b', customer: 4, nth: 2, done: ['closed'], title: '지갑 횟수 사용으로 시술 결제' },
    { key: 'f7', customer: 5, nth: 1, done: ['checkout_ready', 'closed'], title: '시술 일부 수납(미수 남김)' },
  ];

  const finance = financeRows.map(([type, amount, ago, category, counterparty], index) => ({
    index, body: { transaction_type: type, amount, transaction_date: addDays(today, -ago), category, counterparty: `${MARK} ${counterparty}`, memo: `${MARK} #${String(index + 1).padStart(2, '0')} ${category}`, is_archived: false },
  }));

  const templates = templateRows.map(([name, description, content, publish]) => ({ name: `${MARK} ${name}`, description, content, publish }));
  const documents = documentRows.map(([title, status, template], index) => ({
    index, title: `${MARK} ${title}`, status, template,
    content: `${MARK} 데모 문서 본문입니다. (${index + 1}/10)\n실제 매장 자료가 아니며 연습용으로 만든 내용입니다.`,
  }));
  const consents = [
    { treatment: 0, template: 0, sign: true, deliver: true },
    { treatment: 1, template: 0, sign: true, deliver: false },
    { treatment: 2, template: 1, sign: false, deliver: false },
  ];
  const files = fileRows.map(([name, contentType], index) => {
    const original = `${MARK}_${name}`;
    const text = contentType === 'text/csv' ? `이름,값\n${MARK} 데모 ${index + 1},${(index + 1) * 100}\n` : `${MARK} 데모 파일 ${index + 1}\n실제 자료가 아닌 연습용 텍스트입니다.\n`;
    return { original_name: original, content_type: contentType, bytes: new TextEncoder().encode(text) };
  });

  return {
    today, customers, tasks, staff, timeOff, services, resources, appointments, treatments, saleDrafts, products, receipts, stockAdjustments, flows, finance, templates, documents, consents, files,
    closeDate: addDays(today, -3),
  };
}

/** 영역별 생성 예정 개수 요약(dry-run과 --help에서 쓴다). */
export function planSummary(plan, keys = STEP_ORDER) {
  return keys.map((key) => ({ key, label: STEP_META[key].label, counts: STEP_META[key].counts(plan) }));
}
