# CRM-014 고객 보유·파기 기반 구현 기록 (2026-10-21)

## 사용자 결정

사용자는 권고 초안을 채택했다: 조직별·데이터 분류별 보유기간, 고객 관계 종료를 기산 기준으로 사용, 거래/법정 보존 기록 분리, 분쟁 보류, 관리자 확인과 감사 이벤트. 각 조직은 실제 정책에 맞는 기간을 입력한다. 제품은 기간 값을 임의로 채우지 않는다.

## 구현

- `migrations/097_customer_retention_controls.sql`: 정책 분류 7개(`profile`, `sensitive_notes`, `treatment_photos`, `consent_records`, `transaction_records`, `dispute_records`, `audit_events`), 버전 필드, 관계 종료 상태, 고객별 보류 이력, 불변 관리 이벤트를 추가했다.
- owner/admin 전용 RPC가 조직 역할을 DB에서 확인한다. 직접 테이블 변경 권한은 주지 않는다. 정책 낙관적 잠금, 미래 종료일 차단, 중복 보류·중복 해제 거절을 포함한다.
- 관계 종료 전 예약 중(`reserved`, `confirmed`, `checked_in`) 예약과 잔액/횟수가 남은 회원권이 있으면 DB가 거절한다. 종료/재개와 보류/해제에는 사유를 기록한다.
- API는 조직 CRM 접근 검사를 하고 경로 조직만 사용한다. 고객관리의 `보유·파기 정책` 팝업은 선택 고객의 보유 기간, 관계 상태, 법적 보류를 보여주고 수정한다.
- SQL 095의 직접 고객 DELETE 차단은 계속 적용된다. SQL 097에는 `purge_customer` RPC가 없다. 팝업에도 삭제 실행 버튼은 없다.

## 검증 결과

- `node scripts/db-tests/customer-retention-097.mjs`: 통과. NULL 기본 기간, 범위 검증, 정책 버전 충돌, 다른 조직 거절, 미래 종료일 거절, 미해결 예약/회원권 잔액의 종료 차단, 보류 중복/해제/역할 경계, 이벤트 기록, 파기 RPC 미노출을 확인.
- `pnpm --filter @business-assistant/api test -- src/routes/customers.test.ts`: 19 tests 통과.
- `pnpm --filter @business-assistant/desktop-react test -- src/features/customers/CustomerRetentionDialog.test.tsx`: 2 tests 통과.
- `pnpm --filter @business-assistant/api build`: 통과.
- `pnpm --filter @business-assistant/desktop-react build`: 통과. 기존 대형 번들 경고가 출력됨.
- 실 Supabase 적용, 실조직 동작, 설치된 Windows 앱 화면 인수는 하지 않았다. 원격 SQL 097 적용 여부는 확인할 수 없다.

## 남은 제한

보유 기간 설정/관계 종료/보류는 최종 삭제를 의미하지 않는다. 실제 파기 전에는 예약·매출·환불·회원권/원장·발급 문서·서명 증빙·고객/시술 사진과 private Storage 객체를 데이터 묶음별로 분리해야 한다. 감사 이벤트는 고객 파기와 함께 삭제하면 안 되며 최소 식별자 처리 방식과 자체 보유기간을 별도로 정해야 한다. DB, Storage, 백업의 작업 큐·재시도·멱등성·파기 완료 증거, API 추가 공격/조직 경계 테스트, UI/실환경 검증도 남아 있다. 이 상태에서 CRM-014는 `in-progress`다.
