# B1–B13 집중 회귀 점검 (2026-10-20)

이 기록은 구현된 B1–B13 흐름의 격리 PostgreSQL/API/React 회귀를 묶는다. 이는 실 Supabase, 설치된 Tauri 앱, 매장 실사용 인수가 아니다. Supabase SQL은 사용자가 065까지 적용했다고 보고했으며 066~096의 원격 적용은 확인하지 않았다.

## 검증 결과

| 범위 | 실행 | 결과 |
| --- | --- | --- |
| B1/B2/B3: FEFO 로트, 분류·바코드, 단가 스냅샷, 수당 규칙 | `node scripts/db-tests/purchase-orders.mjs` | 통과: 구매/부분입고/로트·유통기한·FEFO/원가 스냅샷/시행 수당/상품 메타데이터/재시도·조직 권한 |
| B1/B2 화면·API | `pnpm --filter @business-assistant/desktop-react test -- src/features/catalog/inventoryAdmin.test.tsx`; API catalog 테스트 | React inventory/catalog 33건, API catalog 54건 통과 |
| B2 상품 이미지 | `node scripts/db-tests/catalog-product-images.mjs` | 통과: 형식·용량·조직 경계·관리자·멱등·버전 잠금·보관 제한 |
| B13 대시보드 위젯/설정 | `pnpm --filter @business-assistant/desktop-react test -- src/features/dashboard/DashboardPage.test.tsx src/store/preferences.test.ts` | 통과, 위젯 표시·순서 및 설정 회귀 포함 |
| B4 최종 손익 | `node scripts/db-tests/management-profit-finalization.mjs` | 통과: 확정 선행조건·역할·조직 경계·revision 멱등·감사·불변 스냅샷 |
| B5 수당 확정·복수 담당 | `node scripts/db-tests/commission-settlements.mjs` | 통과: 60/40 장바구니 배분 저장·재시도, 원 단위 잔액, 수납·환불일 시행 규칙·기간 마감·직원 범위 |
| B6–B9 예약/지점/시리즈/대기 제안 | `node scripts/db-tests/appointments.mjs --series --offers --branches` | 통과, 종료 코드 0 |
| B10 회원권 환불 | `node scripts/db-tests/wallet-usage.mjs --refund` | 통과: 13개 그룹. 할인/횟수/복합 혜택의 현금 환불·혜택 회수 분리 포함 |
| B11 파일 용량/버전/요금제 상한 | `node scripts/db-tests/file-versions.mjs`; `pnpm --dir scripts/db-tests test:file-storage-plan-quota-096`; API admin/files·SQL 계약 45건; React FilePage/AdminSubscription 32건; API·React 빌드 | 통과. SQL 096 격리 검증은 활성·체험 플랜 상한, 조직 상한과 최소값, 예약 멱등성, 다운그레이드 후 초과 보존/신규 업로드 차단을 확인. 요금제 값은 미설정이며 실DB 적용 전 |
| API 예약·시간·자원·대기·상태 | appointment-resources 3개 테스트와 `src/routes/appointments.test.ts` | 통과: 4개 파일, 99개 테스트 |
| React 예약·시간·대기·자원 | AppointmentPage, FormAvailability, AvailabilitySearch, WaitlistDialog, appointment-resources 테스트 | 통과: 5개 파일, 86개 테스트 |
| API 카탈로그·손익·파일 | catalog, management, files 테스트 | 통과: 3개 파일, 86개 테스트 |
| React 카탈로그·손익·파일 | catalog, ManagementPage, FilePage 테스트 | 통과: 3개 파일, 77개 테스트 |

전체 테스트 스위트는 실행하지 않았다. 실제 예약표·Supabase Storage 버킷·조직 권한과 지점 데이터는 아직 운영 인수 범위에 포함하지 않았다.

## 미완료 게이트

- B11: 요금제별 선택 상한과 다운그레이드 초과 처리는 SQL 096/API/관리자 화면에 구현·격리 검증됐다. SQL 076/088/090/096 원격 적용과 플랜별 실제 용량 수치는 잔여다. 외부 공유 링크는 접근·만료·철회 정책 결정이 필요하다([D-21](../pending-decisions-2026-10-14.md)).
- B12: 고객·사진·동의서·감사 이벤트의 보유기간과 법정 보존 예외가 정해지지 않았다. D-10 정책 조사 결과만으로 임의 기간을 정하지 않으며 파기 UI/RPC는 구현하지 않았다.
- TEAM-11 API 계약은 `pnpm --filter @business-assistant/api test -- --run src/modules/sales/carts.test.ts` 44건, 장바구니 화면은 `pnpm --filter @business-assistant/desktop-react test -- --run src/features/sales/SalesPage.test.tsx` 10건, API/React 빌드는 통과했다. 세부는 [복수 담당자 수당 배분 감사](2026-10-20-staff-commission-splits.md).
- 모든 SQL 066~096은 사용자 보고상 아직 적용 전이다. 현재 기록 기준 사용자가 적용 완료를 보고한 최신 SQL은 065다.
