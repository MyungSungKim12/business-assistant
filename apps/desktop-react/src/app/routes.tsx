import type { MenuId } from '../features/shell/TopBar';

export type AppRoute = MenuId;

const titles: Record<MenuId, string> = {
  dashboard: '오늘의 매장', tasks: '할 일', customers: '고객관리', appointments: '예약', treatments: '시술관리', sales: '매출·수납',
  memberships: '회원권', inventory: '상품·재고', services: '서비스', staff: '직원관리', finance: '정산', documents: '문서·동의', files: '파일자료',
  management: '경영 미리보기', members: '구성원', audit: '감사 로그', admin: '구독 관리',
};

export const routeTitle = (route: AppRoute) => titles[route];
