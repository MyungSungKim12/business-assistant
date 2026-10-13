import type { MenuId } from './TopBar';

export interface MenuEntry {
  id: MenuId;
  label: string;
  /** 한 줄 설명. 전체 메뉴 패널에서 보여 준다. */
  description: string;
  /** 아이콘 대신 쓰는 한 글자 표식 */
  mark: string;
  /** 소유자·관리자에게만 보이는 메뉴 */
  managerOnly?: boolean;
  /** 플랫폼 관리자(서버가 /admin/me 로 알려 준 경우)에게만 보이는 메뉴. 조직 역할과 무관하다. */
  platformAdminOnly?: boolean;
}

export interface MenuGroup {
  title: string;
  entries: MenuEntry[];
}

/** 상단 주 메뉴에 항상 보이는 항목. 전체 메뉴 패널에는 나머지를 분류별로 보여 준다. */
export const coreMenus: Array<[MenuId, string]> = [
  ['dashboard', '홈'], ['tasks', '할 일'], ['customers', '고객관리'], ['appointments', '예약'], ['treatments', '시술'], ['sales', '매출'],
];

const coreDescriptions: Partial<Record<MenuId, string>> = {
  dashboard: '오늘의 매장 현황', tasks: '할 일과 일정', customers: '고객 정보와 상담 이력', appointments: '예약 등록·변경과 일정', treatments: '시술 기록과 상담', sales: '매출·수납',
};

export const moreGroups: MenuGroup[] = [
  {
    title: '매장 운영',
    entries: [
      { id: 'services', label: '서비스', description: '서비스별 소요 시간·여유 시간과 필수 공간·장비', mark: '서' },
      { id: 'staff', label: '직원', description: '예약 담당자와 근무시간·휴무 관리', mark: '직' },
      { id: 'memberships', label: '회원권', description: '고객 지갑 잔액·횟수·만료 조회', mark: '권' },
      { id: 'inventory', label: '재고', description: '상품·회원권 판매 조건, 입고·재고 조정과 이력', mark: '재' },
    ],
  },
  {
    title: '정산·문서',
    entries: [
      { id: 'finance', label: '정산', description: '수입·지출, 미수금과 일 마감', mark: '정' },
      { id: 'documents', label: '문서', description: '문서·서식 버전, 동의서 발행과 서명', mark: '문' },
      { id: 'files', label: '파일', description: '매장 파일 자료 업로드·다운로드·보관', mark: '파' },
    ],
  },
  {
    title: '관리',
    entries: [
      { id: 'management', label: '경영', description: '운영 수지와 담당별 매출 근거(미리보기)', mark: '경', managerOnly: true },
      { id: 'members', label: '구성원', description: '매장 구성원 추가·역할 변경·제거', mark: '원', managerOnly: true },
      { id: 'admin', label: '구독', description: '조직 구독 플랜 교체(플랫폼 관리자 전용)', mark: '구', platformAdminOnly: true },
    ],
  },
];

const isVisible = (entry: MenuEntry, canManage: boolean, platformAdmin: boolean) =>
  (!entry.managerOnly || canManage) && (!entry.platformAdminOnly || platformAdmin);

/** 현재 사용자에게 보여 줄 전체 메뉴 패널 그룹. 비어 있는 그룹은 뺀다. platformAdmin 은 서버가 확인해 준 경우에만 true 로 넘긴다. */
export function visibleGroups(canManage: boolean, platformAdmin = false): MenuGroup[] {
  return moreGroups
    .map((group) => ({ ...group, entries: group.entries.filter((entry) => isVisible(entry, canManage, platformAdmin)) }))
    .filter((group) => group.entries.length > 0);
}

export const moreMenuIds = (canManage: boolean, platformAdmin = false): MenuId[] => visibleGroups(canManage, platformAdmin).flatMap((group) => group.entries.map((entry) => entry.id));

/** 전체 검색에서 이동 대상으로 보여 줄 메뉴(주 메뉴 + 더보기). 고객관리는 기능이 켜진 경우에만. */
export function searchMenus(canManage: boolean, platformAdmin: boolean, customerEnabled: boolean): Array<{ id: MenuId; label: string; description: string }> {
  const core = coreMenus
    .filter(([id]) => id !== 'customers' || customerEnabled)
    .map(([id, label]) => ({ id, label, description: coreDescriptions[id] ?? '' }));
  const more = visibleGroups(canManage, platformAdmin).flatMap((group) => group.entries.map((entry) => ({ id: entry.id, label: entry.label, description: entry.description })));
  return [...core, ...more];
}
