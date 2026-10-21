# INV-003 로트·유통기한·FEFO — 2026-10-20

## 범위

- 발주 입고와 수기 입고에 로트 번호·유통기한을 기록한다.
- 양수 재고 원장은 해당 로트를 만든다. 판매, 시술 소모, 반품, 폐기, 실사 등 음수 원장은 만료되지 않은 로트 중 유통기한이 빠른 순서로 수량을 차감한다. 유통기한이 같은 경우 먼저 입고한 로트, 그다음 ID 순서다. 기한 없는 기존·신규 재고는 날짜 있는 로트 뒤에서 사용한다.
- 만료 재고는 재고 합계에는 남겨 두되 출고 배분에서 제외한다. 만료 로트만으로 출고를 요청하면 트랜잭션 전체를 거절한다.
- 잔량이 있는 로트 목록에 만료 경과, 30일 이내 임박, 정상 상태를 표시한다.

## 기존 데이터 처리

066 실행 당시 기존 상품의 현재 재고 수량을 `기존 재고`라는 유통기한 미등록 로트로 복사한다. 고객·예약·상품 원장은 변경하지 않는다. 기존 출고 원장의 로트를 추정하거나 과거 재고를 날짜가 있는 로트로 꾸며내지 않는다. 그 결과 과거 재고의 유통기한은 새 입고 로트보다 뒤에 차감된다.

## 구현과 검증

- SQL: `migrations/066_inventory_lots_fefo.sql` — 조직 범위 복합 키, RLS, 사용자 직접 쓰기 차단, 권한 검사 RPC, 입고 멱등성 지문, 재고 로트 차감 트리거.
- API: catalog 로트 조회 및 수기/발주 입고 요청에 `expires_on`, `lot_code` 추가.
- React: 수기/발주 입고의 로트·유통기한 입력과 상품별 잔여 로트/상태 조회.
- SQL 091/API/React: 조직 전체의 남은 수량이 있는 기한 경과·30일 이내 로트를 한 화면에서 조회하고 해당 상품 로트 상세로 이동한다. 상품이 판매 중지되어도 남은 재고가 있으면 알림에 포함한다. 기한이 빠른 순서로 200건씩 페이지를 이어 볼 수 있고 최대 5,000건에서 한도를 알린다. 페이지 오류·새로고침 상태를 분리한다.
- 권한은 읽기 역할(owner/admin/member)과 조직 ID를 DB RPC에서 재검사한다. API 응답에도 조직/상품 경계를 검증한다.
- 격리 PostgreSQL: `npm run test:purchase-orders --prefix scripts/db-tests` 통과. 부분 입고, FEFO, 만료 임박, 만료 재고 차단과 관리자 권한을 검증했다.
- API: `pnpm --filter @business-assistant/api test -- src/modules/catalog/catalog.test.ts` 통과(49개).
- React: `pnpm --filter @business-assistant/desktop-react test -- src/features/catalog/catalog.test.tsx` 통과(30개).
- API 빌드: `pnpm --filter @business-assistant/api build` 통과.

## 적용 순서와 제한

1. Supabase SQL Editor에서 `migrations/066_inventory_lots_fefo.sql` 실행한다. 001~065가 적용되어 있어야 한다.
2. API를 재시작하고 React/Tauri 앱을 새로 실행한다.
3. 테스트 조직에서 발주와 수기 입고의 기한 입력, FEFO 출고, 만료 재고 출고 거절, 로트 목록을 확인한다.

## 2026-10-20 조직 전체 유통기한 알림 추가

- 검증: `node scripts/db-tests/purchase-orders.mjs` 통과(조직 전체 정렬, 페이지 이동, 미기한 로트 제외, 만료 로트 포함, 타 조직 거절, 마이그레이션 재적용 포함). API catalog 54개 및 React catalog 42개 집중 테스트를 확인한다.
- SQL 091은 Supabase 미적용이다. 앱에서 보려면 091을 090 다음에 적용하고 API/데스크톱 앱을 재시작해야 한다. 원격 DB 권한과 실제 앱 화면 인수는 미확인이다.

066은 아직 운영 Supabase에 적용되지 않았다. 본 검증은 격리 PGlite·API 테스트·React 테스트에 한정되며 실 Supabase 권한 왕복과 Windows 앱 창 인수는 미확인이다. 상품 분류·이미지·바코드(B2), 개봉 후 사용기한(`opened_at`), 창고/지점별 로트 위치, 재고 평가액 계산은 이번 범위에 포함하지 않았다. 구매 발주 단가(`unit_cost`)는 존재하지만 lot 단위 원가와 평균/선입선출 원가 정책은 B3에서 별도로 정해야 한다.
