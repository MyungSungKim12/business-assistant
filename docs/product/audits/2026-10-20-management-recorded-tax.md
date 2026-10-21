# LAB-10 경영 보고의 기록 세금 분리

기록일: 2026-10-20 · 상태: source-verified · SQL 086 적용 전

## 구현 범위

- 경영 미리보기는 선택 기간에 재무 지출로 기록되고 분류가 `세금`, `tax`, `taxes`, `tax expense`인 금액을 합산한다. 조직·기간·보관 상태를 조회 조건에 포함한다.
- 기록된 세금 지출은 기존 전체 지출과 순액에 이미 반영되어 있으므로, 세전 운영 잔액 계산에서만 되돌려 분리한다. 확정 수당은 완전한 조회 기간의 settlement 원장에서 차감한다.
- 화면에는 세전 잔액, 확정 수당 차감 후 세전 잔액, 수당 및 기록 세금 차감 후 참고 잔액을 각각 표시한다. 확정 수당이 없거나 원가를 확인하지 못하면 계산 결과를 비워 둔다.
- 응답은 `is_final_profit=false`를 유지하고 제외 항목으로 `unrecorded_taxes`를 반환한다. 경영 보고 권한은 기존 owner/admin 제한을 유지한다.

## 검증

- `node scripts/db-tests/management-recorded-tax.mjs`: 격리 PGlite에서 세금 분류 기간 합계, 조직 경계, 세전/수당/기록 세금 계산, 수당 기간 누락 시 계산 보류, 권한 거절을 확인했다.
- `pnpm --filter @business-assistant/api test -- management.test.ts`: API 계약·권한 테스트 통과.
- `pnpm --filter @business-assistant/desktop-react test -- src/features/management/ManagementPage.test.tsx`: 화면 요약 및 세전/세금 차감 표시 테스트 통과.
- 실제 Supabase와 설치 앱은 실행하지 않았다. 전체 테스트도 실행하지 않았다.

## 제한

이 보고서는 사용자가 입력한 세금 분류 지출만 분리한다. 실제 신고·납부 의무, 세액, 누락 비용, 부가세 환급, 법인/소득세, 고정급·급여를 계산하지 않는다. 따라서 기록 세금 반영 잔액도 최종 손익이나 세무 자료가 아니다. 운영 DB에서 `세금` 지출을 누락 없이 기록하고 있는지 확인해야 한다. 086은 085 뒤에 적용해야 한다.
