# LAB-10 관리자 확인 손익 스냅샷

기록일: 2026-10-20 · 상태: source-verified · SQL 089 Supabase 적용 전

## 구현 범위

- owner/admin이 과거 기간에 한해 관리 손익을 확정할 수 있다. 원가 미확인 수량이 0이고 조회 기간 전체의 수당 정산이 끝났으며 기록 손익을 계산할 수 있어야 한다.
- 확정 시 관리자가 기간 내 수입·지출, 급여·수당, 세금 및 재고 원가 기록이 완전하다고 확인한다. 입력 완전성은 시스템이 외부 자료와 대조해 증명하지 않는다.
- 확정값은 기간별 불변 revision 스냅샷으로 저장한다. 수정 사유를 남겨 새 revision을 만들며, 감사 이벤트와 요청 ID 멱등 재시도를 기록한다. 직접 테이블 조회/수정 권한은 열지 않고 RPC가 조직·역할을 검사한다.
- React 경영 화면에서 확정 전제, 완전성 체크, 수정 사유, 확정 이력 및 실패 재시도 안내를 제공한다.
- 공식 회계·세무 신고 자료가 아니다. 미기록 비용, 급여, 미신고 의무, 세액을 판정하지 않는다.

## 검증

- `node scripts/db-tests/management-profit-finalization.mjs`: 격리 PGlite에서 정상 확정, 동일 operation ID 재시도, 사유가 있는 revision, 감사 이력, 직접 조회 권한 차단, 스냅샷 변경 방지, 누락 원가/수당/완전성 확인 거부, 다른 조직·일반 구성원 차단을 확인했다.
- `pnpm --filter @business-assistant/api test -- src/modules/management/management.test.ts`: 15개 통과.
- `pnpm --filter @business-assistant/desktop-react test -- src/features/management/ManagementPage.test.tsx`: 17개 통과.
- `pnpm --filter @business-assistant/desktop-react build`: 통과. 기존 대형 청크 경고는 남아 있다.
- 실제 Supabase 적용, 앱 실행, 전체 기능 테스트는 하지 않았다.

## 적용 및 제한

사용자가 보고한 최신 적용 번호는 065다. 066~089를 빠짐없이 순서대로 적용한 다음 API와 앱을 갱신한다. 089는 086의 기록 세금 포함 손익 미리보기를 이용한다. 실 DB 적용과 역할/기록 검산 전까지 기능은 `in-progress`로 둔다.
