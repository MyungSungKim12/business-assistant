# N1030-01 고객 조회·홈 집계 성능 검증

- 기록일: 2026-11-02
- 대상: N1030-01 / CRM-011, DASH-001. 선행 고객 search/get API 및 SQL061 방문 사실 조회를 사용한다.
- 상태: 로컬 집중 검증 완료. SQL101 원격 적용·원격 권한 검증 및 실제 설치본 화면 인수는 이 보고서 작성 시점 미완료다. 상위 진행 문서·원격 적용 기록은 주 에이전트가 관리한다.

## 구현 및 재개 시 수정

시술·매출·수납 고객 선택은 useCustomerSelection의 50건 서버 검색과 선택 ID 단건 조회를 사용한다. 검색 밖 선택 ID를 결과에 유지하고 검색 실패/재시도·오래된 검색 및 선택 응답·조직 전환을 처리한다. 시술의 외부 focus 변경은 기존 초안 이탈 확인을 거친다. CustomerPage의 기존 status=all 계약은 그대로다.

재개 시 발견된 문제는 비보관 고객 선택기가 status=all 첫 페이지를 받은 후 보관 고객을 제거하던 동작이다. 이름순 처음 50명이 보관 고객이면 빈 화면과 잘못된 총 건수가 생겼다. 선택기는 includeArchived=false일 때 exclude_archived=true를 보내고, API가 명시적 true/false만 허용하며, gateway는 status.neq.archived 조건을 페이지 제한과 exact count 이전에 적용한다. vip/inactive/blocked 같은 비보관 상태도 포함한다. 기존 선택 ID는 검색 상태와 별도로 유지한다.

홈은 get_customer_dashboard RPC로 조직 전체 비보관 고객 수·7일 예정 고객 수를 집계하고 실제 방문 최근 5명·예약 예정 10명만 반환한다. 수기 프로필 날짜를 실적에 사용하지 않는다. SQL061과 동일하게 취소되지 않은 과거 방문, 완료된 과거 시술, 현재 이후 reserved/confirmed 예약만 사용한다. 일정/회원권 표시에는 소비하는 고객 ID만 조회한다. 시술·매출·홈 정상 동선에는 전체 고객 목록 조회가 없다.

## 관련 변경 파일

- apps/desktop-react/src/features/customers/useCustomerSelection.ts, useCustomerSelection.test.tsx, customerSearch.ts
- apps/desktop-react/src/features/treatments/TreatmentPage.tsx, TreatmentPage.test.tsx
- apps/desktop-react/src/features/sales/SalesPage.tsx, SalesPage.test.tsx, PaymentHistoryPanel.tsx, testkit.tsx
- apps/desktop-react/src/features/dashboard/DashboardPage.tsx, DashboardPage.test.tsx, dashboardApi.ts, useDashboardData.ts, components/CustomerPanels.tsx, components/MetricCards.tsx
- apps/desktop-react/src/api/client.ts, client.test.ts, schemas.ts
- apps/api/src/routes/customers.ts, customers.test.ts, customer-dashboard.test.ts
- apps/api/src/supabase/customers.ts, legacy-lists.test.ts
- migrations/101_customer_dashboard_queries.sql
- scripts/db-tests/customer-dashboard-101.mjs

위 목록에는 재개 전 구현분을 포함한다. 이번 재개에서 직접 수정한 범위는 archive 제외 query 계약의 route/gateway/helper/hook 및 회귀 테스트와 이 보고서다. 다른 기능의 기존 미커밋 변경을 보존했다.

## 2026-11-02 실행 결과

| 정확한 명령 | 결과 |
| --- | --- |
| pnpm --filter @business-assistant/api exec vitest run src/routes/customers.test.ts src/routes/customer-dashboard.test.ts src/supabase/legacy-lists.test.ts | 3 파일, 29 테스트 통과 |
| pnpm --filter @business-assistant/desktop-react exec vitest run src/features/customers/useCustomerSelection.test.tsx src/features/treatments/TreatmentPage.test.tsx src/features/sales/SalesPage.test.tsx src/features/dashboard/DashboardPage.test.tsx src/api/client.test.ts | 5 파일, 95 테스트 통과 |
| pnpm --filter @business-assistant/desktop-react exec vitest run src/features/customers/useCustomerSelection.test.tsx | 추가한 오래된 선택-ID 응답 회귀 포함 5 테스트 통과 |
| pnpm --filter @business-assistant/api exec tsc -p tsconfig.json --noEmit | 통과 |
| pnpm --filter @business-assistant/desktop-react exec tsc -b --pretty false | 통과 |
| node scripts/db-tests/customer-dashboard-101.mjs | PGlite 격리 DB 통과: 1501명 정확한 집계, 10/5건 제한, 실제 방문 의미, 보관 제외, 다른 조직/JWT 없음/anon 거부, SQL 재적용 |

API 타입 검사 첫 실행에서 누락된 CustomerSearchQuery 선택 필드를 발견했고 추가 후 위 명령 재실행이 통과했다. 데스크톱 95건 실행 이후에는 테스트 1건만 추가했고 해당 hook 파일을 다시 실행했다.

## 검증 경계와 다음 단계

- 서버 CRM 기능/조직 접근 검사, gateway 반환 조직 검사, SQL security invoker 및 JWT/조직 역할·RLS 경계를 확인했다.
- 자동 UI 테스트는 검색 밖 선택·시술 초안 유지·focus 취소, 검색 실패/재시도 및 오래된 응답, 조직 변경, 홈 집계 동선을 검증한다. 새 테스트는 보관 고객 50명이 앞서는 페이지와 vip 고객, includeArchived 전환, 선택 ID 변경 뒤 늦은 응답을 검증한다.
- 화면 증거: 이번 범위에서는 실제 앱을 실행하거나 스크린샷을 생성하지 않았다. 위 React 자동 테스트가 화면 동선의 로컬 증거다.
- 전체 테스트·실제 앱/설치본 실행·운영 데이터 변경·커밋·푸시는 수행하지 않았다.
- SQL101은 격리 엔진에서 검증되었으나 실제 Supabase planner/대량 운영 데이터 성능 측정과 원격 적용은 주 에이전트의 후속 범위다. 응답 크기는 제한되며 정확한 전체 집계 자체는 해당 조직의 관련 기록을 읽는다.
- 원격 SQL101 적용 전 새 dashboard API는 RPC 미존재로 실패할 수 있으므로 서버/앱 활성화 순서에 SQL 적용이 선행되어야 한다.

## 독립 검토 후 보완 및 최종 재검증

주 에이전트가 전달한 독립 검토의 P1/P2 두 건을 반영했다.

- P1: 외부 시술 focus가 고객 ID를 먼저 바꾼 뒤 단건 조회를 기다려 이전 편집기가 새 ID와 연결되던 문제를 수정했다. 대상 고객을 먼저 조회·조직/ID 검증하고, 조회 완료 시점의 현재 초안 상태로 이탈 확인한 뒤 고객 ID·기록·편집기를 함께 전환한다. 승인 시 이전 이력 요청 generation을 즉시 무효화한다. 느린 조회 중 새로 작성한 입력의 취소 보존 및 조회 실패 시 이전 고객/초안 보존을 회귀 테스트로 추가했다.
- P2: 매출 관련 고객 이름 단건 조회 실패를 무시하고 같은 방문 ID 집합의 새로고침에서 재시도하지 않던 문제를 수정했다. 이름 조회 실패를 화면에 명시하고 자료 새로고침 revision으로 동일 ID도 다시 조회한다. 첫 조회 실패 후 같은 방문 목록으로 새로고침하면 단건 조회가 재실행되고 오류가 해제되는 테스트를 추가했다.

최종 실행: pnpm --filter @business-assistant/desktop-react exec vitest run src/features/customers/useCustomerSelection.test.tsx src/features/treatments/TreatmentPage.test.tsx src/features/sales/SalesPage.test.tsx src/features/dashboard/DashboardPage.test.tsx src/api/client.test.ts → **5 파일 99 테스트 통과**. 추가 테스트의 타입 문제를 보완한 뒤 pnpm --filter @business-assistant/desktop-react exec tsc -b --pretty false → **통과**. 위 API 29건 및 격리 SQL101 결과는 관련 구현이 이후 변경되지 않아 유효하다.

## 주 에이전트 원격 적용·최종 검토 (2026-11-02)

- 독립 리뷰의 고객 focus/매출 이름 재시도 두 발견 수정 후 재리뷰에서 추가 중요 회귀가 보고되지 않았다.
- node scripts/db-tests/customer-dashboard-101.mjs 재실행 PASS, PC production build(type+Vite) 통과. 기존 큰 청크 경고는 유지한다.
- 사용자 사전 승인으로 business-assistant (rtmcrptkzcauzrwcfbph)에 SQL101을 적용했다. name 101_customer_dashboard_queries, version 20261102004544.
- 실제 테이블 RLS/의존성과 100까지의 원격 이력을 먼저 확인했다. 적용 후 고객 총19명/비보관19명 유지, customers_dashboard_active 인덱스·SECURITY INVOKER·고정 빈 search_path·authenticated 실행 허용/anon 거부 확인. subject 없는 호출은 실제 DB에서 거부됐다.
- 원격 조회는 스키마/건수만 확인했으며 고객 이름·메모·사진 내용은 출력하지 않았다. 실제 앱·실제 API JWT와 운영 대량 부하 인수는 미진행이다. 위 작성 시점 원격 미적용 문구는 이 후속 기록으로 갱신한다.
