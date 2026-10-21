# 2026-10-20 원가 기반·수당 규칙·경영 보고 보완

## 범위

- INV-11/LAB-10: 068에서 입고 단가를 로트 원가로 보존하고, FEFO로 소비한 로트별 수량과 원가를 출고 원장에 고정한다. 수기 입고에도 매입 단가 입력을 제공하며 모르는 과거·기초 원가는 NULL로 둔다. 원래 판매 배분의 비용 정보가 있는 환불은 복원 로트에 가중 평균 단가를 되돌린다.
- TEAM-11: 069에 시행일별 직원·서비스·상품·회원권 수당 규칙을 추가했다. 규칙은 `net_paid`(항목별 실수납 배분액) 정률만 지원한다. 겹치는 기간은 거절하고 owner/admin RPC로만 등록·종료한다. 직원 메뉴에 규칙 관리 팝업을 연결했다.
- LAB-10: 070에서 상품 판매와 시술 소모 원가, 환불 재입고 원가 및 미확인 출고 수량을 기간별 경영 미리보기에 노출한다. 미확인 출고가 있으면 원가 반영 운영 잔액은 null이다. 수당·세금이 연결되지 않아 보고서의 `is_final_profit`는 계속 false다.

## 검증

- `npm run test:purchase-orders --prefix scripts/db-tests`: 통과. 입고 단가가 로트로 이어지고 FEFO 출고 원가 스냅샷, 적용 기간/중복/종료/권한 및 재실행을 확인했다.
- `npm run test:catalog-sales --prefix scripts/db-tests`: 통과. 알려진 매입 단가가 시술 소모 원가로 보고되고 관리 미리보기가 원가 필드를 반환하는 것을 확인했다.
- `pnpm --filter @business-assistant/api test -- src/modules/management/management.test.ts src/modules/catalog/catalog.test.ts`: 62 tests 통과.
- `pnpm --filter @business-assistant/desktop-react test -- ManagementPage.test.tsx catalog.test.tsx`: 48 tests 통과. 수당 관리 팝업 진입 테스트 포함.
- `pnpm --filter @business-assistant/api build`: 통과.
- `pnpm --filter @business-assistant/desktop-react build`: 통과. 기존 번들 500KB 경고가 표시된다.

## 적용 및 제한

- 신규 SQL 066~070은 Supabase 실환경에 적용하지 않았다. 순서와 기능별 영향은 [migrations/README](../../../migrations/README.md)를 따른다.
- 실 Supabase 권한·데이터와 Windows 앱 화면에서의 확인은 하지 않았다.
- 발주 라인의 단가는 계속 입력한 원화 단가다. 공급 단위와 판매 단위의 변환·부대 운임 배분은 아직 없다.
- 수당 규칙 설정은 가능하지만 거래별 할인·복합 결제·환불의 실제 수납 배분, 수당 계산·정산 확정/정정, 직원 자기 기록 접근은 아직 없다.
- 세금 데이터와 급여 확정이 없어 이 값은 최종 손익이 아니다. 미확인 비용은 0으로 바꾸지 않는다.

## 다음 단계

TEAM-11에서 수당 근거·확정 원장과 직원별 권한, APT-15/16 예약 기능, INV-11 이미지·구매 단위, 나머지 승인된 백로그 항목을 순차 구현한다. 이 작업 이후 손익의 최종 표시를 검토한다.
