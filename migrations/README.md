# 인증·조직·구독 마이그레이션

2026-10-21 원격 확인: 저장소 최신 migration은 **099**이며, Supabase `business-assistant` migration 이력에서 066~099 적용을 확인했습니다. 아래 번호별 적용 안내는 작성 당시의 기록을 보존한 것으로, “적용 대기” 문구는 현재 적용 상태를 나타내지 않습니다. 최신 보안 점검은 [감사 기록](../docs/product/audits/2026-10-21-supabase-migration-and-security.md)을 참고하세요.

현재 실행 절차: 이미 066~099가 적용되어 있으므로 이 구간을 다시 실행하지 마세요. 다음 DB 변경이 필요하면 새 순번 migration을 적용하고, 기능별 격리 테스트와 실환경 인수는 별도로 진행합니다.

064까지 적용했다면 **065_merge_customers_waitlist.sql 하나를 추가 실행**합니다. 고객 병합 함수가 예약 대기 목록을 대표 고객으로 옮기도록 교체합니다(자세한 내용은 아래 065 항목). 적용 후 API와 앱을 재시작합니다.

065까지 적용했다면 **066_inventory_lots_fefo.sql 하나를 추가 실행**합니다. 재고 로트·유통기한, FEFO 출고 배분, 임박·경과 상태 조회와 입고 시 로트 입력을 추가합니다. 기존 수량은 유통기한 미등록의 `기존 재고` 로트로 옮겨지며, 자동 추정하지 않습니다. 적용 후 API와 앱을 재시작합니다. [INV-003 적용·검증·제한](../docs/product/audits/2026-10-20-inventory-lots-fefo.md).

066까지 적용했다면 **067_catalog_category_barcode.sql**을 실행합니다. 상품 분류·조직 내 고유 바코드와 관리자 저장 RPC를 추가합니다. 적용 후 API와 앱을 재시작합니다.

083까지 적용했다면 **084_purchase_unit_conversion.sql**을 실행합니다. 상품의 매입 단위와 단위당 재고 환산 수량, 발주 시점 환산값 스냅샷, 소수점 6자리 기준 재고 원가를 추가합니다. 066~083을 아직 실행하지 않았다면 번호 순서대로 먼저 적용해야 합니다. [INV-11 구현·검증·제한](../docs/product/audits/2026-10-20-purchase-unit-conversion.md).

084까지 적용했다면 **085_appointment_series_reschedule.sql**을 실행합니다. 반복 예약에서 선택한 미래 회차를 기준으로 주기·날짜·자원을 바꾸고 예약 충돌을 원자적으로 검사합니다. 066~084를 아직 적용하지 않았다면 먼저 번호 순서대로 실행합니다. [APT-16 범위와 검증](../docs/product/audits/2026-10-20-appointment-series.md).

090까지 적용했다면 **091_inventory_lot_expiry_alerts.sql**을 실행합니다. 재고 화면에 조직 전체의 기한 경과 및 30일 이내 로트 알림을 추가하고, 200건 단위 페이지 탐색(최대 5,000건)을 제공합니다. 066~090을 아직 적용하지 않았다면 먼저 순서대로 실행합니다. [INV-11 구현·검증·제한](../docs/product/audits/2026-10-20-inventory-lots-fefo.md).

063까지 적용했다면 **064_treatment_visit_link.sql 하나를 추가 실행**합니다. 개별 시술의 예약·방문 연결 컬럼·범위 검사·감사 RPC를 추가하며 기존 기록은 자동 연결하지 않습니다. 적용 후 API와 앱을 재시작합니다. [적용·검증·제한](../docs/product/audits/2026-10-20-treatment-visit-link.md).

063은 직원 프로필 버전·관리자 수정 RPC와 예약 배정/상태의 활성 담당자 재검증 트리거이며 사용자 적용 완료 보고 상태입니다. [검증·제한](../docs/product/audits/2026-10-19-staff-customer-profiles.md).

이전 061은 실제 방문·다음 예약 요약, 062는 노쇼 사유·상태 이력입니다. [061 기록](../docs/product/audits/2026-10-19-customer-visit-facts.md), [062 기록](../docs/product/audits/2026-10-19-appointment-status-history.md). 고객 병합(044)은 되돌릴 수 없으므로 테스트 데이터로 먼저 검증하세요.

이 디렉터리의 SQL은 Supabase PostgreSQL에 인증, 조직 멤버십, 상품, 구독 권한의
기본 구조를 추가합니다. 적용 순서는 다음과 같습니다.

1. `001_auth_entitlements.sql`로 테이블, 인덱스, RLS 정책을 적용합니다.
2. `002_seed_entitlements.sql`로 BASIC, STANDARD, PRO 상품과 기본 기능 코드를
   멱등하게 등록합니다.
3. `003_subscription_and_organization_hardening.sql`로 활성 구독 중복을 막고,
   사용자 JWT만으로 조직 존재 여부를 확인하는 제한된 RPC를 추가합니다.
4. `004_admin_subscription_rpc.sql`로 플랫폼 관리자 전용의 원자적 구독 교체 RPC를
   추가합니다.
5. `005_crm_customers.sql`로 조직별 고객 데이터를 만들고 멤버 조회와 관리자 변경 RLS를
   적용합니다.
6. `006_tasks.sql`로 조직별 작업과 일정 데이터를 만들고 생성자/관리자 변경 RLS를 적용합니다.
7. `007_documents.sql`로 조직별 문서 템플릿과 문서 데이터를 적용합니다.
8. `008_finance_transactions.sql`로 수입·지출 원장과 기간 집계를 적용합니다.
9. `009_file_assets.sql`로 조직별 파일 메타데이터와 비공개 Storage 버킷/RLS를 적용합니다.
10. `010_authenticated_grants.sql`로 Supabase Data API의 `authenticated` 역할에 테이블 권한을 부여합니다. 실제 행 접근은 각 테이블의 RLS가 계속 제한합니다.
11. `011_organization_insert_policy.sql`로 로그인 사용자의 조직 생성 INSERT 정책을 보정합니다. 생성자는 DB 트리거를 통해 owner로 등록됩니다.
12. `012_create_organization_rpc.sql`로 조직 생성을 인증 사용자 전용 RPC로 처리합니다.
13. 이후 번호 순서대로 CRM·시술·문서·사진 기능을 적용한 뒤, `024_visit_sale_carts.sql`로 고객 방문과 검토용 결제 장바구니를 추가합니다. 이 단계는 실제 수납이나 재무 원장을 만들지 않습니다.

적용 전에는 대상 Supabase 프로젝트의 마이그레이션 환경에서 실행하는지 확인합니다.
연결 문자열과 서버 전용 비밀값은 로컬 `.env`에만 보관하고, 데스크톱 앱이나 Git에
저장하지 않습니다.

모든 `public` 애플리케이션 테이블은 RLS를 사용합니다. 멤버십 기반 RLS 조회는
`private.has_organization_role` 함수를 통해 수행해 멤버십 테이블 정책의 재귀를
피합니다. 이 함수는 호출자의 `auth.uid()`와 역할을 직접 확인하며, `authenticated`
역할에만 실행 권한을 부여합니다.

기본 상품 데이터와 스키마는 결제 연동을 포함하지 않습니다. 활성 구독은
`trialing` 또는 `active` 상태이고, `ends_at`이 비어 있거나 미래인 경우로 서버
서비스 계층에서 판정합니다.

### 2026-10-06 수납 기록 추가

- `025_visit_payments.sql`: 현금/카드/이체 불변 수납 기록, 원자적 재무 수입 연결, 수납 시작 후 청구 동결.
- `026_sale_cart_hardening_upgrade.sql`: 이전 024 적용 DB에도 엄격한 입력/권한/재시도/조회/잠금 보완을 반영한다. 함수 교체만 수행하며 방문·영수 기록을 다시 만들지 않는다.
- 신규 DB는 024 → 025 → 026, 이미 024 적용한 DB는 025 → 026 순서다. 적용한 테이블 생성 SQL을 다시 실행하지 않는다. SQL 적용 후 서버/앱을 함께 업데이트한다.
- 실제 운영 DB에는 자동 적용하지 않았다. [상세 인수/제한](../docs/product/visit-payments-release.md).

### 2026-10-07 상품·회원권 판매와 사용

- `027_catalog_sales.sql`: 상품·회원권 마스터, 입고·출고 원장, 완납 시 회원권 발급.
- `028_wallet_usage.sql`: 시술 항목별 금액권/횟수권 차감, 불변 사용 원장, 현금 수납과 합산한 미수금 계산.
- 024~026 적용 DB에는 027 → 028 순서로 실행하고 같은 버전의 서버·앱을 재시작한다. 운영 DB에는 자동 적용하지 않았다.
- [상품 판매 적용 안내](../docs/product/catalog-sales-release.md), [회원권 사용 적용 안내](../docs/product/wallet-usage-release.md).

### 2026-10-07 환불·취소 반대 원장

- `029_payment_refunds.sql`: 원영수증 부분/전체 환불, 회원권 사용 취소, 환불 재무 지출, 전체 취소의 상품 재고·미사용 발급 회원권 반대 원장.
- 027 → 028 이후 029를 적용하고 같은 버전의 서버·앱을 재시작한다. [환불 적용 안내](../docs/product/refund-reversal-release.md).

### 2026-10-08 재고 반품·폐기·실사 조정

- `030_inventory_stock_controls.sql`: 상품 재고 원장에 입고/판매/환불/거래처 반품/폐기/실사 조정 유형을 기록하고, 권한·조직·버전·재고 음수·중복 요청을 검사하는 원자적 조정 RPC를 추가한다.
- 027~029 다음에 030을 적용하고 같은 버전의 서버와 앱을 재시작한다. 운영 DB에는 자동 적용하지 않았다. [사용 및 적용 안내](../docs/product/inventory-stock-controls-release.md).

### 2026-10-08 고객 상품 부분 반품

- `031_customer_product_returns.sql`: 고객 판매 상품 일부 반품·원영수증 환불·재입고/폐기 원장을 한 트랜잭션에 묶고, 이후 전체 취소 시 반품된 상품 수량의 중복 재입고를 막는다.
- 030 다음에 031을 적용하고 같은 버전의 서버와 데스크톱을 재시작한다. 사용자는 030 적용 완료를 보고했으며 031 운영 DB 적용은 미실행이다. [사용·검증 안내](../docs/product/customer-product-returns-release.md).

### 2026-10-08 장바구니 할인

- `032_sale_cart_discounts.sql`: 첫 수납 전 owner/admin 수동 고정액·비율 할인, immutable 변경 이력, 장바구니 재계산 및 할인 반품액 배분을 추가한다.
- 사용자는 030 적용 완료를 보고했다. 따라서 031 → 032 순서로 실행하고 서버·데스크톱을 재시작한다. 031/032 운영 DB 적용 여부는 아직 확인하지 않았다. [반품 적용 안내](../docs/product/customer-product-returns-release.md), [할인 적용 안내](../docs/product/sale-cart-discounts-release.md).

### 2026-10-08 일 마감·미수 목록

- `033_sale_daily_closings.sql`: 한국 시간 영업일 기준 수단별 수납·환불, 미수금, 현금 시재 대사, 권한 제한 마감과 append-only 정정 이력. 마감된 날짜에는 해당 날짜로 귀속되는 추가 수납·환불을 막는다.
- 사용자는 031 → 032 → 033 순서로 모두 실행했다고 보고했다. 독립 실DB 검증은 아직 수행하지 못했다. [사용·검증 안내](../docs/product/sale-daily-settlement-release.md).

### 2026-10-08 예약 기본 운영

- `034_appointments.sql`: 직원·서비스 기본 마스터, 예약 슬롯/상태, 직원 버퍼 충돌, 방문·장바구니 연결.
- 사용자 보고상 031~033은 실행 완료. 이후 **034만** SQL Editor에서 실행하고 서버·데스크톱을 같은 버전으로 재시작한다. 이 작업에서는 운영 DB에 실행하지 않았다. [기능 및 제한](../docs/product/menus/03-appointments.md#2026-10-08-구현검증-기록).

### 2026-10-08 회원권 정지·재개·연장

- `035_wallet_lifecycle.sql`: 관리자 사유·버전·멱등 ID로 정지·재개·연장을 기록하고, 정지 중 사용을 차단한다.
- 034 이후 035 순서로 실행한다. 운영 DB 자동 적용은 하지 않았다. [제한 및 근거](../docs/product/menus/06-memberships-packages.md).

### 2026-10-08 운영 수지·담당 매출 근거

- `036_management_preview.sql`: 관리자 전용 읽기 보고서. 확정 이익·수당이 아니며 제외된 원가를 함께 반환한다.
- 035 다음 036 순서로 실행한다. 운영 DB 자동 적용은 하지 않았다. [직원 범위](../docs/product/menus/08-staff-commissions.md) · [손익 범위](../docs/product/menus/09-expenses-settlement-profit.md).

## 037 예약 담당자 근무시간·휴무

- `037_appointment_availability.sql`: 담당자별 요일 근무시간과 휴무를 버전·작업 ID로 관리하고, 근무시간 밖 또는 휴무와 겹치는 예약을 DB에서 차단한다.
- 사용자는 036까지 적용했다고 보고했다. 현재 소스에서는 **037을 먼저 실행한 뒤 038**을 적용하며, 서버와 데스크톱도 같은 소스로 재시작해야 한다. 운영 DB 자동 적용은 하지 않았다. [예약 범위](../docs/product/menus/03-appointments.md).

## 038 예약 공간·장비

- `038_appointment_resources.sql`: 공간·장비 마스터, 서비스별 필수 자원 수량, 예약별 자원 선택과 동시간 중복 차단을 추가한다. 여러 자원은 UUID 정렬 순서로 잠가 동시 예약 교착과 이중 배정을 막는다.
- 사용자는 036까지 적용했다고 보고했다. 현재 소스는 **037 → 038** 순서로 실행하고 서버와 데스크톱을 같은 버전으로 재시작해야 한다. 운영 DB 자동 적용은 하지 않았다. [적용·검증 안내](../docs/product/appointment-resources-release.md).

## 039 재무·매출 기능 키

- `039_finance_basic_feature.sql`: `finance.basic` 기능을 등록하고 BASIC·STANDARD·PRO 모든 요금제에 연결한다. 매출 장바구니·수납·정산·재고·재무 API가 `crm.basic`과 함께 이 키를 요구한다. 데이터 변경만 하며 여러 번 실행해도 안전하다.
- 038 다음에 SQL Editor에서 실행한다. 운영 DB 자동 적용은 하지 않았다. 적용 후 매출 화면을 다시 열어 자료가 불러와지는지 확인한다.

## 040 감사 로그

- `040_audit_log.sql`: `public.audit_events`(append-only, RLS: 조직 owner/admin만 조회)와 사용자 토큰으로 호출하는 보안 정의 함수 `public.record_audit_event(...)`를 추가한다. 호출자(`auth.uid()`)가 actor로 강제되고 조직 구성원만 기록할 수 있으며, 서비스 키(관리자 API)는 `source = 'service'`로 직접 insert한다. update/delete/truncate는 트리거로 막는다. 데이터는 새 테이블뿐이고 기존 자료는 바꾸지 않으며 여러 번 실행해도 안전하다.
- **039 다음에** SQL Editor에서 실행한다. 이 작업에서는 운영 DB에 적용하지 않았다. 적용 전에 서버를 새 버전으로 올리면 감사 기록 RPC가 실패하므로, 일반 작업은 계속되지만(경고 로그만) **고객 영구 삭제는 감사 기록이 없으면 거부(fail-closed)된다**. 따라서 040을 먼저 적용한 뒤 서버를 재시작한다. 적용 후 `GET /api/v1/organizations/{조직}/audit-events`로 확인한다.

## 041~045 6단계 기능 마이그레이션 (적용 순서)

**순서: 039 → 040 → 041 → 042 → 043 → 044 → 045.** 각 파일은 여러 번 실행해도 안전하다(멱등). 운영 DB에는 자동 적용하지 않았고, 이 작업 환경에는 PostgreSQL이 없어 SQL을 실제로 실행해 보지 못했다(문자열 계약 테스트만 통과). **먼저 스테이징 DB나 SQL Editor의 트랜잭션 안에서 실행해 보고** 적용한다. **마이그레이션을 먼저 적용한 뒤 API 서버를 재시작하고 앱을 갱신한다.** 새 서버를 먼저 올리면 해당 기능만 503으로 실패하고 기존 기능은 계속 동작한다.

### 041 상품 안전재고·서비스 가격/수정·회원권 이력

- `041_catalog_service_wallet_admin.sql`: 상품별 안전재고(`catalog_products.low_stock_threshold`)와 안전재고 변경 RPC, 서비스 가격·카테고리·편집 버전 컬럼과 서비스 수정·비활성 RPC(`update_appointment_service`), 조직 전체 지갑 목록(`list_organization_wallets`)과 지갑 잔액 변동 이력(`list_wallet_history`) 읽기 RPC를 추가한다. 새 컬럼은 모두 기본값이 있어 기존 자료는 바꾸지 않는다.
- 적용 후 회원권 화면(목록·이력), 서비스 수정, 상품 안전재고 저장으로 확인한다.

### 042 매출 내역 검색·재무 월 마감·전체 미수금

- `042_sales_search_finance_month_close.sql`: 수납·환불·반품 내역 검색 읽기 RPC `list_sale_payments`, 재무 월 마감 테이블 `finance_month_closings`와 마감/재오픈 RPC(owner/admin만), 마감된 달의 `finance_transactions` 입력·수정(보관 포함)을 막는 트리거, 조직 전체 미수금 요약 RPC `get_receivables_summary`를 추가한다. 기존 데이터는 바꾸지 않는다.
- 일 마감(033, 영업일 시재)과 별개의 월 단위 장부 마감이다. **월 마감 후에는 그 달 날짜의 수입·지출 등록·수정과 그 달 날짜로 기록되는 수납·환불이 거절된다**(재오픈 후 가능). 현재 달을 마감하면 오늘 수납도 막히므로 보통 지난달을 마감한다.
- 적용 후 확인: 수납 → 매출 화면 `매출 내역` 탭 조회 → 지난달 `월 마감` → 그 달 날짜 거래 등록 시 안내.

### 043 서명 증빙 해시·시술 사진 전/후 구분

- `043_document_evidence_photo_phase.sql`: 동의서 서명·교부·철회 이벤트의 SHA-256 증빙 해시를 보관하는 append-only 표 `treatment_document_event_proofs`와, 시술 사진 전/후/기타 구분 컬럼 `treatment_photos.phase`(nullable)를 추가한다. 기존 이벤트·사진 행은 수정하지 않는다.
- **043을 먼저 적용한 뒤** 같은 버전의 API 서버와 앱을 배포한다. 적용 전에 새 API를 올리면 동의서 이력 조회와 시술 사진 조회가 실패한다. 기존 이벤트는 "증빙 없음"으로 표시된다.

### 044 고객 검색·태그 관리·중복 병합

- `044_customer_crm_tools.sql`: 고객 상태 제약에 `archived` 추가, 검색·정렬 인덱스, 태그 목록·이름 바꾸기·병합·삭제 RPC, 중복 후보 조회 RPC, 고객 병합 RPC(`merge_customers`)와 병합 이력 테이블을 추가한다. CHECK 제약 교체와 함수·테이블 추가만 한다. **운영 DB의 고객 상태 제약이 이미 다르게 바뀌어 있는지 먼저 확인한다.**
- **병합은 되돌릴 수 없다.** 보조 고객은 보관 상태로 남고 `customer_merge_history`에 스냅샷이 남는다. 시술 판매 인계 기록(`treatment_sale_drafts`)이 있는 고객은 병합할 수 없다. 병합 함수는 여러 테이블의 고객 참조를 한 번에 옮기므로 **반드시 테스트 데이터로 먼저 실행해 확인한 뒤 운영에서 사용한다.**
- 적용 순서: 044 → API 서버 재시작 → 앱 갱신. 앱이 먼저 올라오면 서버 검색 경로가 없어 예전 전체 목록으로 동작한다.

### 045 구성원 관리

- `045_organization_members.sql`: 구성원 관리 RPC 4종(`list_organization_members`, `add_organization_member_by_email`, `set_organization_member_role`, `remove_organization_member`)을 추가한다. 테이블·정책 변경은 없다. `auth.users`를 읽는 보안 정의 함수이므로 적용 후 `authenticated`만 실행할 수 있는지(`anon`·`public` 권한 없음) 확인한다.
- 적용 전에는 구성원 화면이 목록을 불러오지 못하므로 API(구성원 라우트)를 배포하기 전에 먼저 적용한다. 구성원 추가는 **이미 가입한 사용자의 이메일만** 지원한다(이메일 초대 발송 없음). 감사 로그(`member.*`)는 040이 필요하다.

### 046 시술 소모품 재고 차감

- `046_treatment_consumables.sql`: 예약 서비스에 조직별 실물 상품 소모량 기준을 저장하고, 시술 기록에 적용 서비스를 연결한다. 연결된 시술을 완료할 때 서비스 기준량을 재고에서 차감하고 `catalog_stock_ledger`에 `treatment_use` 원장을 같은 트랜잭션으로 기록한다. 재고가 부족하거나 서비스/상품 조직이 다르면 완료 요청 전체가 롤백된다. 기존 시술은 연결하지 않으며 소급 차감하지 않는다.
- 기존 재고 원장의 `customer_return`·`adjustment` 이동 종류와 시술 이벤트의 `consult` 액션을 보존한다. 고객 반품이나 과거 조정 원장이 있어도 제약조건 재생성에 실패하지 않는다.
- **045 다음에 적용한다.** 격리 PostgreSQL 검증은 `npm run test:treatment-consumables --prefix scripts/db-tests`로 실행한다. 이 검증은 운영 Supabase 적용이나 실제 동시 세션 검증을 대신하지 않는다. 로컬 코드에는 서비스별 레시피 관리, 시술 서비스 연결과 매출 화면의 기존 회원권 사용 진입점이 포함돼 있다. DB 적용과 실제 권한 왕복 검증은 별도 인수 항목이다.

## 047 예약 메모·할 일 라벨/체크리스트·고객 마케팅 수신 동의

- `047_ops_memo_labels_consent.sql`: 모두 기본값이 있는 컬럼과 함수 추가라 기존 행을 바꾸지 않는다. 여러 번 실행해도 안전하다(멱등).
  - `tasks.labels`(최대 10개), `tasks.checklist`(JSON 배열, 최대 50항목·20KB)와 개수·크기 제약.
  - `customers.marketing_consent`(기본 false)와 `marketing_consent_at`. 동의 시각은 트리거(`private.stamp_marketing_consent`)가 **값이 바뀔 때** DB에서 찍으므로 클라이언트가 조작할 수 없다. 다른 필드만 바꾸면 시각은 유지된다.
  - `appointments.memo`(최대 1000자)와 `public.set_appointment_memo(조직, 예약, 메모)` RPC. 일정 저장(버전·충돌 검사)과 분리되어 예약 버전을 올리지 않으며, owner/admin/member가 쓸 수 있다.
- **순서: 마이그레이션 적용 → API 서버 재시작 → 앱 갱신.** 새 API는 고객·할 일 조회에 새 컬럼을 읽으므로, 047 적용 전에 서버를 먼저 올리면 고객 목록과 할 일 목록이 실패한다.
- 고객 병합(044)은 수신 동의를 합치지 않는다. 주 고객의 값이 그대로 남으므로 병합 뒤 동의 여부를 확인한다.
- 격리 PostgreSQL(PGlite)에서 `npm run test:ops-047 --prefix scripts/db-tests`로 제약·동의 시각 트리거·메모 권한과 다른 조직 격리를 검증했다. 실제 Supabase 적용과 역할별 확인은 아직이다.

## 048 반복 할 일·고객 연결

- `048_task_recurrence_customer.sql`: `tasks.recurrence`(daily/weekly/monthly, 없으면 null), `tasks.customer_id`(같은 조직 고객만, 고객 삭제 시 연결만 해제), `tasks.recurrence_source_id`와 트리거를 추가한다. nullable/기본값 컬럼이라 기존 행은 바뀌지 않고 여러 번 실행해도 안전하다. 047 이후에 적용한다.
- **반복 동작**: 기한이 있는 반복 할 일을 `done`으로 바꾸면 **같은 트랜잭션에서** 다음 할 일이 생성된다. 제목·설명·우선순위·라벨·고객·반복 주기를 복사하고 체크리스트는 모두 미완료로 되돌린다. 다음 기한은 한국 시간 벽시계 기준으로 일/주/월을 더하며(1/31 + 1개월 = 2/28), 이미 지난 날짜면 오늘 이후가 될 때까지 같은 간격으로 건너뛴다. 한 할 일이 낳는 다음 반복은 최대 1건이라, 다시 열었다가 또 완료해도 중복되지 않는다. 기한이 없으면 반복하지 않는다. 구성원이 만든 반복 할 일을 관리자가 완료해도 작성자는 원래 작성자로 유지된다.
- **담당자 지정은 넣지 않았다**: 구성원 목록은 owner/admin만 읽을 수 있고 할 일 수정은 작성자·관리자만 가능해, 담당 구성원이 완료 처리를 못 하는 문제가 있어 권한 설계가 먼저 필요하다.
- **순서: 마이그레이션 적용 → API 서버 재시작 → 앱 갱신.** 새 API가 새 컬럼을 읽으므로 048 적용 전에 서버를 먼저 올리면 할 일 목록이 실패한다.
- 격리 PostgreSQL에서 `npm run test:ops-048 --prefix scripts/db-tests`로 생성 규칙·중복 방지·테넌트 격리·고객 삭제를 검증했다. 실제 Supabase 적용은 아직이다.

## 049 할 일 담당자와 완료자 기록

- `049_task_assignee_completion.sql`: `tasks.assignee_id`(같은 조직 구성원만), `completed_by`·`completed_at`·`completed_by_name`, 담당자용 수정 정책, 트리거 3개, `list_task_people` RPC를 추가한다. 기존 행은 바뀌지 않고 여러 번 실행해도 안전하다. 048 이후에 적용한다.
- **담당자 권한**: 담당자로 지정된 구성원(작성자도 관리자도 아닌 사람)은 **상태와 체크리스트만** 바꿀 수 있다. 제목·설명·기한·담당자 등을 바꾸면 DB가 거절한다(42501). 작성자와 owner/admin은 기존처럼 모든 필드를 수정한다. 지정되지 않은 다른 구성원은 수정할 수 없다.
- **완료자 기록**: 상태가 `done`이 되는 순간 DB 트리거가 **실제로 요청한 사용자**와 시각, 그 시점의 표시 이름을 기록한다. 클라이언트가 보낸 `completed_*` 값은 무시되며(API도 422로 거절), 다시 열면 지워진다. 이름은 완료 시점에 함께 저장하므로 이후 구성원에서 빠져도 "누가 완료했는지"가 남는다. 표시 이름은 프로필 이름이고, 없으면 이메일의 **앞부분만** 쓴다(전체 이메일은 노출하지 않는다).
- **`list_task_people`**: 담당자 선택용 구성원 이름 목록. 구성원 관리 목록(owner/admin 전용, 이메일 포함)과 달리 모든 구성원이 읽을 수 있고 `user_id`와 이름만 돌려준다.
- **반복 할 일**: 다음 회차는 같은 담당자를 이어받는다. 담당자가 그 사이 구성원에서 빠졌으면 담당자 없이 만든다(완료 처리가 실패하지 않는다).
- **순서: 마이그레이션 적용 → API 서버 재시작 → 앱 갱신.** 새 API가 새 컬럼과 RPC를 읽으므로 049 적용 전에 서버를 먼저 올리면 할 일 목록이 실패한다.
- 격리 PostgreSQL에서 `npm run test:ops-049 --prefix scripts/db-tests`로 담당자 범위·완료자 위조 방지·이름 규칙·테넌트 격리·반복 상속을 검증했다. 실제 Supabase 적용은 아직이다.

## 050 서비스별 담당 가능 직원

- `050_service_staff.sql`: 테이블 `appointment_service_staff`(서비스↔직원, 같은 조직 외래 키·cascade), `set_appointment_service_staff(조직, 서비스, 직원 배열)` RPC(owner/admin), 예약 검사 트리거를 추가한다. 새 테이블·함수·트리거뿐이라 기존 행은 바뀌지 않고 여러 번 실행해도 안전하다. 034 이후 언제든 적용할 수 있다.
- **규칙**: 서비스에 지정된 직원이 **하나도 없으면(기본) 모든 직원이 가능**하다. 지정이 있으면 그 직원만 해당 서비스의 예약을 맡을 수 있다. 빈 배열로 저장하면 제한이 풀린다.
- **검사 시점**: 예약을 **새로 만들 때**와 **담당자 또는 서비스를 바꿀 때만** DB 트리거가 검사하고(22023 → API 422), 시간만 바꾸거나 상태를 바꾸는 수정은 검사하지 않는다. 그래서 나중에 지정 목록에서 빠진 직원의 **기존 예약은 계속 관리**할 수 있다. 이미 만들어진 예약은 목록을 바꿔도 바뀌지 않는다.
- 권한: 목록은 모든 구성원이 읽고, 저장은 owner/admin만 한다(RLS와 RPC 모두).
- **순서: 050 적용 → API 서버 재시작 → 앱 갱신.** 새 API는 `appointment_service_staff` 테이블을 읽으므로 적용 전에 서버를 먼저 올리면 서비스·예약 화면의 이 부분만 비어 보이고(앱이 규칙 조회 실패를 무시), 서버 검사는 아직 없다.
- 격리 PostgreSQL에서 `npm run test:ops-050 --prefix scripts/db-tests`로 실제 `save_appointment` 경로의 강제 여부, 교체 의미, 권한, 다른 조직 격리, 멱등을 검증했다. 실제 Supabase 적용은 아직이다.

## 051 시술 프로토콜 템플릿

- `051_treatment_protocol_templates.sql`: 테이블 `treatment_protocol_templates`(이름·분류·시술명·시술 내용·상담 목표·예정 관리), 정책, 버전·시각 트리거를 추가한다. 새 테이블·함수·트리거뿐이라 기존 행은 바뀌지 않고 여러 번 실행해도 안전하다. 적용 후 API 서버를 재시작한다.
- **복사 방식**: 템플릿은 시술 기록·상담에 **값을 복사**할 뿐 연결되지 않는다. 템플릿을 고치거나 지워도 이미 쓴 기록은 바뀌지 않는다.
- **권한**: 목록은 모든 구성원이 읽고, 만들기·수정·삭제는 owner/admin만 한다(RLS). 작성자는 DB 기본값(`auth.uid()`)이 채운다.
- **이름 규칙**: 한 매장에서 이름은 대소문자·앞뒤 공백을 무시하고 하나만 쓴다(중복은 API 409). 수정할 때마다 `version`이 올라가며 API는 `expected_version` 조건으로 낙관적 잠금을 건다(오래된 버전은 409).
- 한도: 이름 120자, 분류 100자, 시술명 200자, 시술 내용 10,000자, 상담 목표 2,000자, 예정 관리 5,000자(시술 기록·상담 한도와 같다).
- **순서: 051 적용 → API 서버 재시작 → 앱 갱신.** 적용 전에 서버를 먼저 올리면 시술 화면의 템플릿 부분만 비어 보이고(앱이 불러오기 실패를 무시) 나머지 시술 기능은 그대로 동작한다.
- 격리 PostgreSQL에서 `npm run test:ops-051 --prefix scripts/db-tests`로 권한·중복 이름·한도·버전·낙관적 잠금·다른 조직 격리·멱등을 검증했다. 실제 Supabase 적용은 아직이다.

## 052 반복 지출

- `052_finance_recurring_expenses.sql`: 테이블 `finance_recurring_expenses`(이름·금액·분류·거래처·메모·매달 나가는 날·사용 여부), `finance_recurring_runs`(어느 달에 어느 거래로 등록했는지), 정책·트리거, `generate_finance_recurring_expenses(조직, 월)` RPC를 추가한다. 새 테이블·함수뿐이라 기존 행은 바뀌지 않고 여러 번 실행해도 안전하다. **042(재무 월 마감) 이후**에 적용한다. 적용 후 API 서버를 재시작한다.
- **자동 실행은 없다.** 관리자가 재무 화면의 "반복 지출" 탭에서 "이 달 반복 지출 등록"을 눌러야 그 달의 지출이 만들어진다.
- **중복 방지**: (반복 지출, 달) 하나만 기록하므로 같은 달에 여러 번 눌러도 이미 등록한 항목은 건너뛴다. 나중에 새로 만든 항목만 추가로 등록된다. 비활성 항목은 등록하지 않는다.
- **날짜**: 매달 나가는 날이 31일처럼 그 달에 없으면 그 달의 마지막 날로 맞춘다. 거래 메모에는 "반복 지출: 이름 — 메모"가 들어간다.
- **마감·범위**: 마감된 달(042)에는 아무것도 등록하지 않고 "Finance month is closed"(P0001, API는 한국어 안내가 있는 409)로 거절한다. 재오픈하면 다시 등록할 수 있다. 다음 달보다 먼 미래는 등록할 수 없다(22023). 등록은 한국 시간 기준 달이다.
- **템플릿을 고치거나 지워도 이미 등록한 거래는 바뀌지 않는다.** 등록된 거래는 일반 수입·지출과 같아서 이후 수정·보관은 기존 방식이다.
- **권한**: 목록은 모든 구성원이 읽고, 만들기·수정·삭제·월 등록은 owner/admin만 한다(RLS와 RPC). 같은 이름은 대소문자·공백을 무시하고 하나만 쓴다. 수정은 버전 조건으로 낙관적 잠금을 건다.
- **순서: 052 적용 → API 서버 재시작 → 앱 갱신.** 적용 전에 서버를 먼저 올리면 "반복 지출" 탭만 오류를 보이고 나머지 재무 기능은 그대로 동작한다.
- 격리 PostgreSQL에서 `npm run test:ops-052 --prefix scripts/db-tests`로(실제 042 마감 트리거 포함) 권한·한도·날짜 보정·중복 방지·마감 거절·재오픈·다른 조직 격리·멱등을 검증했다. 실제 Supabase 적용은 아직이다.

## 053 고객 사진 휴지통

- `053_customer_photo_trash.sql`: `customer_photos`에 `archived_at`·`archived_by`·`archived_by_name`·`archived_reason` 컬럼, 삭제 기록 트리거, 휴지통 조회 인덱스를 추가한다. nullable/기본값 컬럼이라 기존 행은 바뀌지 않고 여러 번 실행해도 안전하다. **049(`private.person_name`) 이후**에 적용한다. 적용 후 API 서버를 재시작한다.
- **삭제 기록은 DB가 찍는다**: 사진이 보관(삭제)되는 순간 호출한 사용자·시각·그 시점의 표시 이름을 기록하고, 복원하면 모두 지운다. 클라이언트가 보낸 `archived_*` 값은 무시된다. 이름은 삭제 시점에 저장하므로 이후 구성원에서 빠져도 남는다(프로필 이름이 없으면 이메일 앞부분만 쓴다).
- **사유**: 사용자가 삭제하면 `deleted`(휴지통에 보임), 업로드 실패 뒤 정리는 `upload_failed`(휴지통에 보이지 않음). 사유를 보내지 않는 예전 API의 삭제는 `deleted`로 본다.
- **053 이전에 삭제된 사진은 휴지통에 나타나지 않는다**(삭제 시각·사유 기록이 없고 업로드 실패 정리 행과 구분할 수 없다). 필요하면 SQL로 `is_archived=false`로 되돌릴 수 있다.
- **저장소 파일은 삭제하지 않는다.** 휴지통에는 복원만 있고 영구 삭제·보관 기간 후 자동 파기는 없다(정책 결정 전, [보류 항목](../docs/product/pending-decisions-2026-10-14.md) D-10).
- 휴지통 목록과 복원은 owner/admin만 쓴다(API와 RLS). 구성원 화면에는 휴지통 버튼이 없다.
- **순서: 053 적용 → API 서버 재시작 → 앱 갱신.** 적용 전에 서버를 먼저 올리면 사진 삭제가 `archived_reason` 컬럼 없음으로 실패하므로 반드시 먼저 적용한다.
- 격리 PostgreSQL에서 `npm run test:ops-053 --prefix scripts/db-tests`로 삭제 기록·위조 값 무시·복원·사유 구분·권한·다른 조직 격리·멱등을 검증했다. 실제 Supabase 적용은 아직이다.

## 054 시술 문서 서식 자동 채움 항목 확장

- `054_document_template_fields.sql`: 019의 렌더러(`private.render_treatment_document`)를 같은 규칙으로 다시 정의해 서식 본문에서 쓸 수 있는 `{{항목}}`을 늘린다. 함수 교체뿐이라 기존 행·발행본은 바뀌지 않고 여러 번 실행해도 안전하다. **019(와 017 컬럼) 이후**에 적용한다. API 서버 재시작은 필요 없다(앱만 갱신하면 새 항목이 선택 목록에 나온다).
- **추가된 항목**: `{{organization.name}}`(매장 이름), `{{today}}`(오늘 날짜, 한국 시간 YYYY-MM-DD), `{{customer.skin_type}}`, `{{customer.allergies}}`(알레르기·주의사항), `{{treatment.category}}`(시술 분류), `{{treatment.next_visit_date}}`, `{{treatment.consultation_plan}}`(예정 관리 내용). 기존 8개 항목의 결과는 그대로다.
- **비어 있는 값은 누락으로 보고 발행을 막는다**(기존 규칙 그대로). 알레르기처럼 "없음"과 "미등록"을 구분해야 하는 항목은 자동으로 '없음'을 채우지 않으므로, 직원이 고객 정보를 확인해 입력한 뒤 발행한다.
- **발행본에는 그 시점의 값이 고정된다**: 발행 스냅샷(`source_snapshot`)에 매장 이름·발행일·피부 타입·알레르기·시술 분류·다음 방문일·예정 관리 내용이 함께 저장되고, 이후 고객 정보를 바꿔도 발행본은 변하지 않는다.
- **자정 주의**: `today`는 한국 시간 날짜라서, 미리보기를 연 뒤 자정을 넘겨 발행하면 "미리보기와 달라졌다"(409)로 거절된다. 다시 미리보기를 열면 된다.
- 054 적용 전에는 새 항목이 알 수 없는 항목으로 취급되어 발행이 막힌다(앱을 먼저 갱신하면 새 항목을 넣은 서식이 발행되지 않을 수 있으니 SQL을 먼저 적용한다).
- 격리 PostgreSQL에서 `npm run test:ops-054 --prefix scripts/db-tests`로 적용 전후 동작, 새 항목 채움, 스냅샷, 발행본 고정, 빈 값 차단, 구성원 접근, 멱등을 검증했다. 실제 Supabase 적용은 아직이다.

## 055 할 일과 예약 연결

- `055_task_appointment_link.sql`: `tasks.appointment_id`와 조직 복합 외래 키를 추가한다. 다른 조직 예약은 연결할 수 없고, 예약을 삭제해도 할 일은 남으며 예약 연결만 끊긴다. 연결할 때 할 일의 고객은 해당 예약의 고객으로 DB가 맞춘다. 반복 할 일의 다음 회차에는 특정 예약을 복사하지 않는다.
- 034 예약과 048 할 일 이후에 적용한다. nullable 컬럼과 제약·트리거만 추가하며 기존 할 일을 변경하지 않는다. 여러 번 실행해도 안전하다.
- **순서: 055 적용 → API 서버 재시작 → 앱 갱신.** API는 새 `appointment_id` 컬럼을 읽으므로 SQL 적용 전 새 API를 실행하면 할 일 목록을 읽지 못할 수 있다.
- 해당 조직에서 예약 목록을 조회할 수 있는 사용자는 할 일의 예약 선택 상자에서 예약을 연결할 수 있다. 기존 예약을 편집하거나 삭제하는 동작과는 분리되어 있다.
- 격리 PostgreSQL에서 `npm run test:ops-055 --prefix scripts/db-tests`로 같은 조직 연결, 다른 조직 차단, 고객 동기화, 예약 삭제 시 연결 해제, 멱등 실행을 확인한다. 실제 Supabase 적용·실계정 권한 왕복 검증은 별도 인수 단계다.

## 056~058 대기 목록·파일 분류·구매 발주

- `056_appointment_waitlist.sql`: 조직별 예약 대기 목록을 추가한다. 고객·시술·담당자 참조는 조직 복합 외래 키로 제한하고, 상태 전이와 버전 증가는 DB 트리거가 검사한다. 구성원은 조회·등록·상태 변경을 할 수 있다.
- `057_file_folders_tags.sql`: 조직별 파일 폴더와 파일의 `folder_id`·`tags` 메타데이터를 추가한다. Storage 객체 경로와 기존 파일은 이동하지 않는다. 읽기는 구성원, 분류 수정은 관리자 권한으로 제한한다.
- `058_purchase_orders.sql`: 공급처, 발주서·품목, 입고 원장을 추가하고 원자적 RPC로 초안 생성·상태 변경·부분 입고를 처리한다. 입고 시 발주 잔량, 상품 재고, 불변 재고 원장이 함께 갱신된다. `purchase_order_receipt` movement kind를 추가한다.
- 적용 순서는 **055 → 056 → 057 → 058 → API 서버 재시작 → 앱 갱신**이다. 2026-10-16 사용자 보고상 058까지 적용됐다. 다른 환경에서는 이미 적용한 SQL을 건너뛰고 DB의 마지막 적용 번호 다음부터 실행한다. 각 SQL은 재실행에 안전하도록 작성했다.
- `056~058` 적용 전에는 해당 기능 API를 사용할 수 없다. 현재 앱은 파일 폴더 API가 아직 없는 경우 기존 파일 목록을 계속 표시하지만 분류 기능은 동작하지 않는다.
- 격리 PostgreSQL 테스트 `npm run test:purchase-orders --prefix scripts/db-tests`는 공급처·발주 재시도 충돌·부분/중복 입고·초과 입고 거절·재고 원장·관리자 권한을 검증한다. Supabase SQL 적용은 사용자 보고이며, 실조직 왕복 검증은 아직 하지 않았다.

## 059 예약 대기 재시도 및 예약 전환

- `059_waitlist_idempotent_booking.sql`은 대기 등록 operation ID, 대기 상태 RPC, 변환 원장을 추가한다. `book_appointment_from_waitlist`는 동일 조직의 활성 고객/직원/시술과 자원 충돌을 기존 예약 RPC에서 검사하고, 대기 상태 변경까지 같은 트랜잭션에서 처리한다.
- 같은 요청의 재시도는 같은 결과를 반환한다. 이미 전환한 대기 건을 다른 요청으로 다시 예약하려 하면 충돌로 거절한다. 대기 테이블 직접 쓰기는 차단하고 RPC 권한을 사용한다.
- 적용 순서는 **059 → API 서버 재시작 → 앱 갱신**이다. 2026-10-16 사용자 보고상 059까지 실행했다. 이미 적용한 환경에서 이 문서 때문에 다시 실행할 필요는 없다. 원격 적용 상태는 독립 확인하지 않았다.
- API 예약 집중 테스트와 SQL 소스 계약은 점검 대상이다. 실제 Supabase 실행·동시 요청·조직별 역할 검증은 별도 실환경 인수 단계다.

## 065 고객 병합의 예약 대기 목록 이동

- `065_merge_customers_waitlist.sql`: 044의 `merge_customers`를 다시 정의해 `appointment_waitlist`(056)의 고객을 대표 고객으로 옮긴다. 044 이후에 만든 테이블이 병합 이동 목록에서 빠져 있어, 병합 뒤에도 대기 건이 보관된 보조 고객에 남아 대표 고객 화면에서 보이지 않던(이후 보조 고객을 영구 삭제하면 함께 사라지는) 문제를 막는다. 044 파일은 수정하지 않고 함수만 교체하며 시그니처·권한(owner/admin, authenticated 실행)은 같다.
- 순서: **065 적용 → API 서버 재시작 → 앱 갱신**. 새 컬럼이 없어 앱 호환성 문제는 없고, 함수 교체라 재실행해도 안전하다.
- 검증: API 계약 테스트(`migrations.customers044.contract.test.ts`)가 `customer_id`를 가진 모든 테이블이 최신 `merge_customers`에서 이동되는지 검사한다. 격리 DB에서 실제 병합을 수행하는 테스트는 `npm run test:customer-merge-065 --prefix scripts/db-tests`다(아래 검증 항목). 실제 Supabase 적용은 사용자 몫이다.
- 고객 병합은 되돌릴 수 없다. 065 적용 전에는 대기 목록이 있는 고객을 병합하지 않는다.
- `scripts/db-tests/customer-merge-065.mjs`는 065의 실제 함수를 격리 DB에서 실행해 모든 `customer_id` 테이블(대기 목록 포함)의 이동·건수 기록, 다른 고객/조직 행 불변, 보조 고객 보관, 필드 병합, 같은 요청 재시도/충돌, 이미 병합된 고객·결제 인계 기록 거절, 구성원·익명 권한 거절을 확인한다. 새 마이그레이션이 `customer_id` 테이블을 추가하면 이 테스트가 실패해 병합 함수 갱신을 강제한다. 065 적용은 사용자 보고(실행 완료)이며 실계정 병합 확인은 별도다.

## 066 재고 로트·유통기한·FEFO

- `066_inventory_lots_fefo.sql`: 기존 재고 수량을 기한 미등록 `기존 재고` 로트로 보존하고, 이후 양수 원장 이벤트는 로트를 만든다. 발주/수기 입고 RPC에 로트 번호·유통기한 입력을 추가한다.
- 판매·시술 소모·거래처 반품·폐기 등 음수 원장 이벤트는 만료되지 않은 로트에서 FEFO 순서(가까운 유통기한 → 입고 순 → ID 순)로 자동 차감한다. 날짜 없는 재고는 날짜가 있는 로트 뒤에 차감한다. 만료 로트만으로는 출고하지 않으며 원장 기록도 트랜잭션과 함께 롤백된다.
- `list_catalog_inventory_lots`는 잔여 로트와 `expired`, `expiring_soon`(30일 이내), `ok` 상태를 반환한다. 읽기는 조직 구성원, 입고·재고 변경은 기존 owner/admin RPC 권한을 사용한다.
- 적용: **065 → 066 → API 재시작 → 앱 재시작**. 이미 적용한 065는 다시 실행하지 않는다. 기존 상품 재고의 실제 유통기한은 자동으로 추정되지 않는다.
- 격리 테스트: `npm run test:purchase-orders --prefix scripts/db-tests`. 실 Supabase 적용은 아직이며, `066`은 신규 미적용이다.

## 067 상품 분류·바코드

- `067_catalog_category_barcode.sql`: 기존 상품은 `기타` 분류와 빈 바코드(null)로 보존한다. 바코드는 조직 안에서 중복될 수 없다. 상품 수정은 전용 버전 검사·멱등 RPC를 사용한다.
- 상품 분류와 바코드는 목록에 표시하고 검색할 수 있으며, 분류 필터를 제공한다. 상품 이미지 업로드·저장은 포함하지 않는다.
- 적용: **066 → 067 → API 재시작 → 앱 재시작**. DB 격리 검증은 `npm run test:purchase-orders --prefix scripts/db-tests`, API 검증은 catalog test다. 067은 신규 미적용이다.

## 068~070 원가·수당 규칙·관리 원가

- `068_inventory_cost_basis.sql`: 매입 단가를 입고 로트에 저장하고 판매/시술 소모 때 출고 배분별 원가를 불변 스냅샷으로 남긴다. 수기 입고에서도 단가를 입력할 수 있고, 모르면 NULL로 둔다. 환불 재입고는 원래 판매 로트 원가를 복원한다. 이전 입고·기초 재고는 추정하지 않는다.
- `069_staff_commission_rules.sql`: owner/admin만 시행일이 있는 정률 수당 규칙을 등록·조회·종료할 수 있다. 직원·서비스·상품·회원권 대상, `net_paid` 계산 기준, 기간 중복 거절을 저장한다. 계산 명세·확정 원장과 직원별 접근 화면은 후속 TEAM-11 작업이다.
- `070_management_cost_basis.sql`: 경영 미리보기에 상품 판매 및 시술 소모의 원가, 환불 재입고 원가, 원가 미확인 출고 수량을 더한다. 미확인 수량이 있으면 원가 반영 운영 잔액을 표시하지 않으며, 직원 수당·세금이 빠져 있으므로 최종 손익은 계속 false다.
- 적용 순서: **066 → 067 → 068 → 069 → 070 → API 재시작 → 앱 재시작**. 이전 SQL을 이미 적용한 환경은 적용 번호 다음부터 실행한다. 본 작업 기준 066~070은 새 SQL이며 Supabase에는 아직 적용되지 않았다.
- 격리 DB 검증: `npm run test:purchase-orders --prefix scripts/db-tests`, `npm run test:catalog-sales --prefix scripts/db-tests`. 원가 적용 및 기간 보고 테스트 포함. API/React 집중 테스트 및 빌드 결과는 `docs/product/audits/2026-10-20-cost-foundation-and-report.md`에 기록한다.

## 071 반복 예약 시리즈

- `071_appointment_series.sql`: 주/월 주기 예약 시리즈와 회차 연결, 예외 날짜, 충돌 회차 결과를 저장한다. 회차 생성은 기존 예약 RPC를 재사용해 고객·직원·서비스·자원 충돌 검사를 적용한다. 같은 `operation_id`와 입력 재시도는 저장된 결과를 반환한다. 개별 예약 이동·담당/서비스/자원 변경 시 해당 회차를 예외로 표시하고 취소는 예약 상태 이력에 남긴다.
- 새 예약 폼에서 2~52회, 주/월 간격, 최대 52개 예외일을 선택할 수 있다. 충돌 회차는 건너뛰고, 성공 회차가 하나도 없으면 전체 요청을 롤백한다. 기존 예약의 시리즈 일괄 수정, 시리즈 전용 조회 화면, 다중 지점 반복은 포함하지 않는다.
- 적용: **기존 적용 완료 번호 → 071 → API 재시작 → 앱 재시작**. 이 기능 테스트는 `node scripts/db-tests/appointments.mjs --series`, API는 `pnpm --filter @business-assistant/api test -- src/routes/appointments.test.ts`, 화면은 `pnpm --filter @business-assistant/desktop-react test -- src/features/appointments/AppointmentFormAvailability.test.tsx`다. SQL은 Supabase에 아직 적용되지 않았다.

## 072 예약 대기 제안

- `072_waitlist_ranked_offers.sql`: 대기 항목별 후보 시각을 최대 10개까지 순위로 저장한다. 제안 만료는 5분 초과~48시간 이내다. 새 후보 묶음은 이전 활성 묶음을 대체하고, 수락·닫기·만료·대체 이력을 보존한다. 후보는 내부 제안이며 고객에게 자동 발송하지 않는다.
- 제안 수락은 기존 `book_appointment_from_waitlist`를 같은 트랜잭션에서 호출하여 담당자·시간·공간·장비 충돌을 다시 검사하고, 성공하면 대기 건과 나머지 후보를 함께 갱신한다. 실패하면 제안은 살아 있어 다른 시간을 고를 수 있다. 자동 위약금·수수료 없음.
- 적용: **071 → 072 → API 재시작 → 앱 재시작**. 격리 DB는 `npm run test:appointments --prefix scripts/db-tests`로 실행한다. API 집중 검증은 예약 route 테스트, 화면은 `WaitlistDialog.test.tsx`다. SQL 072는 Supabase 적용 대기다.
# 2026-10 추가 기능 묶음 (066 이후)

066~091은 각각 순서대로 적용한다. 특히 073~074는 지점 기반 예약 데이터 모델을, 077은 직원과 조직 계정 연결을, 080~085는 상품 이미지·반복 예약 조회/변경 기능을, 086은 경영 보고의 기록 세금 분리를, 091은 조직 전체 유통기한 알림을 추가한다.

- `073_organization_branches.sql`: 조직 지점 테이블, 기존 조직의 본점 생성, 지점 조회·생성 RPC. 조직 구성원은 조회하고 owner/admin만 생성한다.
- `074_appointment_branch_scope.sql`: 직원·공간·장비·예약에 `branch_id`를 추가하고 기존 행을 본점에 연결한다. 신규 직원·자원은 본점에 배정된다. 예약 지점은 담당자 지점과 같아야 하며 공간·장비 충돌은 같은 지점 안에서만 계산한다. 지점 이동은 owner/admin RPC로만 가능하고, 예정된 예약을 먼저 재배정해야 한다.
- 검증: `npm run test:appointment-branches --prefix scripts/db-tests`는 격리 PostgreSQL에서 두 마이그레이션의 재실행, 기본 지점, 조직 접근 격리, 직원 지점 변경, 예약 귀속을 검사한다. 실제 Supabase 적용/화면 인수는 별도다.
- 순서: 073 적용 → 074 적용 → API 재시작 → 앱 갱신. 사용자에게 두 SQL 파일을 같은 순서로 실행하도록 안내한다.
- `075_wallet_transfer.sql`: 사용 이력·환불 이력이 없고 활성 상태인 회원권만 동일 조직의 활성 고객에게 양도한다. 사유·관리자·이전/새 고객과 버전을 불변 원장에 기록하고 요청 ID 재시도를 지원한다. **029 결제 환불, 035 회원권 수명주기 이후**에 적용한다.
- 검증: `npm run test:wallet-transfer --prefix scripts/db-tests`로 미사용 양도, 사용/환불된 회원권 차단, 역할·고객 검증, 재시도 및 이전 고객 목록에서 빠지는 동작을 격리 DB에서 검사한다. 사용된 회원권의 부분 환불 금액 산정은 별도 정책이 없어 아직 지원하지 않는다.
- `076_file_asset_versions.sql`: 기존 파일을 버전 1로 이관하고 파일별 불변 버전 이력 및 최신 버전 게시 RPC를 추가한다. 새 Storage 업로드를 완료한 후에만 현재 파일 포인터를 바꾸며 이전 객체는 보존한다. 파일별 50MB 제한은 유지한다. 조직 전체 용량 할당량은 요금제별 수치와 실제 객체 용량을 검증할 정책이 없어 포함하지 않았다.
- 검증: `npm run test:file-versions --prefix scripts/db-tests`로 기존 경로 보존, 버전 증가와 낙관적 잠금, 다른 조직 접근 차단, 이력 변경 차단을 확인한다. UI는 버전 목록·이전 버전 다운로드·새 버전 업로드를 제공한다. 적용 순서는 **075 → 076 → API 재시작 → 앱 갱신**이다.
- `077_staff_account_link.sql`: 직원 레코드에 같은 조직의 기존 로그인 구성원 계정을 선택적으로 연결한다. 조직당 계정 1개는 직원 한 명에만 연결되며, 연결 해제도 지원한다. 역할 권한은 계속 `memberships`가 결정하고 연결 여부 자체로 권한을 부여하지 않는다.
- 검증: `npm run test:staff-account --prefix scripts/db-tests`에서 조직 구성원만 연결, 중복 연결·다른 조직·일반 구성원·익명 호출 차단, 버전·멱등 재시도와 연결 해제를 확인한다. API는 appointment-resources 테스트, 화면은 `StaffProfileDialog.test.tsx`다. 적용 순서는 **현재까지 적용한 최신 SQL → 077 → API 재시작 → 앱 갱신**이다.
- `078_staff_time_off_requests.sql`: 연결된 활성 직원이 휴무를 신청하고 owner/admin이 승인·반려하도록 한다. 승인된 신청만 기존 휴무 원장에 생성되어 예약 가능 시간 계산을 막는다. 대기 신청은 예약 슬롯을 차단하지 않는다. 요청·검토·철회 이벤트는 변경/삭제할 수 없으며 직원은 자기 요청만 조회·철회한다.
- 검증: `npm run test:staff-leave --prefix scripts/db-tests`는 연결 직원, 중복 기간, 승인 후 예약 차단, 반려·철회, 재시도·버전·역할·조직 경계를 확인한다. API 테스트는 `appointment-resources.test.ts`, React 테스트는 `appointment-resources.test.tsx`다. 적용 순서는 **077 → 078 → API 재시작 → 앱 갱신**이다. 이번 구현에서 077·078은 실 Supabase에 미적용 상태다.
- `079_staff_commission_settlements.sql`: 날짜가 지난 수납·회원권 사용·환불을 항목별로 배분해 직원 수당을 미리보고 확정 원장으로 고정한다. 항목 할인은 비례 배분하며 원 단위 잔액은 마지막 항목에 맞춘다. 수당 규칙은 거래일 기준 직원별 규칙을 우선한다. 환불은 환불 발생일의 음수 조정으로 기록한다. 수당 미지정·규칙 누락은 확정을 막는다. 관리자만 미리보기·확정할 수 있고, 직원은 연결된 본인 항목만 조회한다. 실제 급여·세금 계산은 포함하지 않는다.
- 적용 순서: **현재 적용한 최신 SQL → 079 → API 재시작 → 앱 갱신**. 집중 검증은 `npm run test:commission-settlements --prefix scripts/db-tests`, API는 `pnpm --filter @business-assistant/api test -- management.test.ts`, React는 `pnpm --filter @business-assistant/desktop-react build`다. SQL 079는 실 Supabase 적용 대기다.
- `080_catalog_product_images.sql`: 상품에 같은 조직의 private 파일을 이미지로 연결한다. JPEG/PNG/WebP만 허용하고 최대 5 MiB를 DB에서 확인한다. 연결 해제는 파일을 지우지 않으며, 연결된 파일의 보관 처리는 차단한다.
- 적용 순서: **079 → 080 → API 재시작 → 앱 갱신**. PGlite 정책 검증은 `npm run test:catalog-product-images --prefix scripts/db-tests`, API는 catalog.test.ts, 화면은 catalog.test.tsx다. SQL 080은 Supabase 적용 대기다.
- `081_appointment_series_list.sql`: 예약 구성원에게 최근 반복 예약 시리즈와 회차/예외 목록을 반환하는 조직 범위 조회 RPC를 추가한다. limit은 1~100으로 제한한다. 회차 개별 수정·취소는 기존 예약 동선에서 하며 해당 회차만 예외로 기록된다.
- 적용 순서: **080 → 081 → API 재시작 → 앱 갱신**. 격리 DB 검증은 `node scripts/db-tests/appointments.mjs --series`, API는 `pnpm --filter @business-assistant/api test -- src/routes/appointments.test.ts`, 화면은 `pnpm --filter @business-assistant/desktop-react test -- src/features/appointments/AppointmentPage.test.tsx`다. SQL 081은 Supabase 적용 대기다.
- `082_appointment_series_future_cancel.sql`: owner/admin만 시리즈의 시작일 이후, 현재 예약/확정 상태인 회차를 한 번에 취소한다. 실제 예약 시각 기준 KST 날짜를 사용하고 방문·완료·취소 상태와 시작일 이전 예약은 유지한다. 취소는 기존 예약 상태 전이/감사 이력을 재사용하며, 여러 회차 작업은 하나의 트랜잭션으로 처리한다. 사유·멱등 키를 요구한다.
- 적용 순서: **081 → 082 → 083 → API 재시작 → 앱 갱신**. 같은 `node scripts/db-tests/appointments.mjs --series`, API 예약 라우트 테스트, React `AppointmentPage.test.tsx`에서 범위·권한·재시도를 검증한다. SQL 082는 Supabase 적용 대기다.
- `083_appointment_series_future_update.sql`: owner/admin이 미래의 예약·확정 상태이며 개별 수정되지 않은 회차에 담당자와 시술을 함께 적용한다. 기존 회차의 개별 예외·취소·방문은 유지한다. 시술 시간 변경에 따른 예약 충돌이나 다른 사용자 변경이 있으면 트랜잭션 전체를 롤백하며 operation_id 재시도를 지원한다.
- 적용 순서: **082 → 083 → API 재시작 → 앱 갱신**. 격리 DB에서 충돌 뒤 선행 회차 롤백, 멱등 재시도, 예외 회차 보존, 역할 차단을 확인한다. SQL 083은 Supabase 적용 대기다.
- `084_purchase_unit_conversion.sql`: 상품의 매입 단위·단위당 재고 수량을 저장하고, 발주 품목에 당시 값을 스냅샷한다. 입고 때 발주 단위 수량을 재고 기본 단위로 환산하며 원가를 소수점 6자리로 보존한다. 기존 자료는 1:1로 초기화한다.
- 적용 순서: **083 → 084 → API 재시작 → 앱 갱신**. 격리 DB는 `node scripts/db-tests/purchase-orders.mjs`, API는 catalog.test.ts, 화면은 catalog.test.tsx와 PurchaseOrdersDialog.test.tsx에서 확인한다. SQL 084는 Supabase 적용 대기다.
- `085_appointment_series_reschedule.sql`: owner/admin이 선택한 미래 회차부터 개별 예외가 없는 예약·확정 회차의 날짜, 반복 간격, 자원을 재계산한다. 회차 번호 간격을 유지하며 각 변경은 기존 예약·자원 충돌 검사 RPC로 수행한다. 충돌·최신 버전 변경·권한 오류는 전체 롤백하고 작업 키 재시도를 보장한다.
- 적용 순서: **084 → 085 → API 재시작 → 앱 갱신**. `node scripts/db-tests/appointments.mjs --series`, API 예약 라우트 테스트, React `AppointmentPage.test.tsx`를 사용한다. SQL 085는 Supabase 적용 대기다.
- `086_management_recorded_tax.sql`: 경영 보고에서 `세금`/`tax` 분류로 실제 입력된 지출을 따로 합산한다. 기존 지출 합계에 이미 포함된 금액이므로 세전 잔액 계산 시 한 번만 분리하고, 확정 수당 차감 후 기록 세금 반영 잔액을 별도 제공한다. 신고 세액 계산·미기록 세금 판정은 하지 않으며 `is_final_profit`은 계속 false다.
- 적용 순서: **085 → 086 → API 재시작 → 앱 갱신**. `node scripts/db-tests/management-recorded-tax.mjs`는 격리 PGlite에서 세금 분류 범위, 세전/수당/기록 세금 합계, 미확정 수당 시 계산 보류, 권한 거절을 확인한다. 실제 Supabase 적용 전이다.
- `087_wallet_partial_refunds.sql`: 판매 할인 후 금액과 금액권 발급액이 같은 활성·미만료 금액권의 실제 외부 환불 완료분을 잔액 한도 내에서 기록한다. 횟수 혜택·복합 혜택·판매가와 발급 금액이 다른 회원권은 잔여 가치를 추정하지 않고 거절한다. 환불액은 지갑 잔액과 재무 지출에서 차감되고 불변 이벤트에 기록되며, 환불일의 수당 미리보기에는 원 판매 항목의 음수 거래로 추가된다. 잔액 0원은 `refunded` 종료 상태다. 외부 카드/현금 환불 자체는 수행하지 않는다.
- 적용 순서: **현재 적용한 최신 SQL → 087 → API 재시작 → 앱 갱신**. 집중 검증은 `node scripts/db-tests/wallet-usage.mjs --refund`, API `pnpm --filter @business-assistant/api test -- src/modules/catalog/catalog.test.ts`, React `pnpm --filter @business-assistant/desktop-react test -- src/features/catalog/catalog.test.tsx`다. 이 테스트는 기존 금액권/복합권 회귀도 같이 실행한다. SQL 087은 Supabase 적용 전이며 적용 이후 실제 조직에서 잔액·재무·환불일 수당 검산이 필요하다.

- `088_file_storage_quotas.sql`: 조직별 기본 5 GiB 저장 용량, 실제 `business-files` Storage 객체 크기 집계, 30분 업로드 예약, 최초 업로드 완료 검증과 파일 버전 업로드의 예약 크기 일치를 강제한다. 파일당 50 MiB 제한은 그대로다. 조직별 한도 값은 DB에서 조정할 수 있으나 요금제 연동/관리 UI는 없다. 미완료 예약은 만료되며 고아 Storage 객체 정리는 별도 운영 절차다.
- 적용 순서: **현재 적용한 최신 SQL → 누락된 066~088 순서 적용 → 089 → 090 → API 재시작 → 앱 갱신**. 집중 검증은 `node scripts/db-tests/file-versions.mjs`, API `pnpm --filter @business-assistant/api test -- src/modules/documents/files.test.ts`, React `pnpm --filter @business-assistant/desktop-react test -- src/features/documents/FilePage.test.tsx src/features/documents/FileUploadPreview.test.tsx src/features/catalog/catalog.test.tsx`다. 현재 사용자가 보고한 최신 적용 SQL은 065이며 066~089는 원격 적용 확인 전이다.

- `089_management_profit_finalization.sql`: owner/admin이 과거 기간의 기록 손익을 관리자 확인과 함께 불변 revision 스냅샷으로 확정한다. 재고 원가 미확인 수량이 0이고 기간 전체 수당 정산·기록 손익 계산이 가능해야 한다. 수정 확정은 사유와 새 revision을 남기며 감사 이벤트를 추가한다. 원장 입력 완전성은 관리자가 확인하며 공식 회계·세무 신고 자료로 표현하지 않는다.
- 적용 순서: **현재 적용한 최신 SQL → 누락된 066~088 순서 적용 → 089 → 090 → API 재시작 → 앱 갱신**. 집중 검증은 `node scripts/db-tests/management-profit-finalization.mjs`, API `pnpm --filter @business-assistant/api test -- src/modules/management/management.test.ts`, React `pnpm --filter @business-assistant/desktop-react test -- src/features/management/ManagementPage.test.tsx`다. 사용자가 보고한 최신 적용 SQL은 065이며 066~090은 Supabase 적용 대기다.


당시 최신 순번: **092_wallet_manual_refunds.sql** — 할인·횟수·복합 회원권 환불에서 실제 외부 환불액과 제거할 혜택을 별도로 기록합니다. [WAL-11 환불 감사 기록](../docs/product/audits/2026-10-20-wallet-partial-refund.md).

- `093_staff_commission_attribution.sql`: 수당 미리보기에서 담당 직원이 누락된 판매 항목을 점주/관리자가 사유와 함께 직원에게 귀속한다. 원 판매 라인은 보존하며 현재 보정 version과 작업자·이유가 담긴 불변 이벤트를 추가한다. finance 관리자 전용 직원 목록 RPC를 제공한다. 기존 수당 규칙과 순수납 배분으로 다시 계산하고, 확정된 정산 라인은 변경할 수 없다.
- 적용 순서: **현재 적용된 최신 SQL → 누락된 SQL 066~092 → 093 → API 재시작 → 앱 갱신**. 사용자는 기존 최신 적용 번호를 065라고 보고했으므로 현재 환경에서는 066부터 순서대로 적용해야 한다. 검증은 `node scripts/db-tests/commission-settlements.mjs`, API `pnpm --filter @business-assistant/api test -- src/modules/management/management.test.ts`, React `pnpm --filter @business-assistant/desktop-react test -- src/features/management/ManagementPage.test.tsx`다. 격리 DB/API/React 테스트만 통과했으며 실 Supabase 적용이나 운영 테스트는 하지 않았다.

당시 최신 순번: **093_staff_commission_attribution.sql** — 담당 누락 수당 항목에 관리자 사유형 귀속 보정을 추가합니다. [수당 정산·귀속 보정 감사 기록](../docs/product/audits/2026-10-20-staff-commission-settlement.md).

- `094_staff_commission_splits.sql`: 장바구니 판매 항목마다 같은 조직의 활성 직원 최대 10명에게 정수 basis point로 배분한다. 합계 10,000을 DB 지연 제약으로 확인하고, 기본 담당자 100%는 기존 수당 계산을 유지한다. 순수납 이벤트 금액을 직원별 비율로 나눈 뒤 직원별 유효 규칙을 적용하고, 마지막 직원이 원 단위 반올림 잔액을 받는다. 결제 후 배분 변경은 장바구니 버전/상태 잠금으로 차단한다.
- 적용 순서: **현재 적용한 최신 SQL → 누락된 066~093 → 094 → API 재시작 → 앱 갱신**. 사용자는 065까지 실행했다고 보고했으므로 현재 환경에서는 066부터 순서대로 적용해야 한다. 격리 DB는 `node scripts/db-tests/commission-settlements.mjs`, API는 `pnpm --filter @business-assistant/api test -- --run src/modules/sales/carts.test.ts`, 화면은 `pnpm --filter @business-assistant/desktop-react test -- --run src/features/sales/SalesPage.test.tsx`다. 이 검증은 통과했으며 실 Supabase 적용 및 운영 인수는 미확인이다. [복수 담당자 배분 감사](../docs/product/audits/2026-10-20-staff-commission-splits.md).

당시 최신 순번: **094_staff_commission_splits.sql** — TEAM-11 판매 항목의 복수 담당자 수당 배분을 추가합니다.

- `095_crm14_block_customer_erasure.sql`: D-10 보관·법정 예외·법적 보류 정책이 결정되기 전 고객 테이블의 authenticated 사용자 DELETE 권한과 관리자 RLS DELETE 정책을 제거한다. 보관/복원은 UPDATE 권한을 유지한다.
- 적용 순서: **현재 적용한 최신 SQL → 빠진 SQL 066~094 → 095 → API 재시작 → 앱 갱신**. 사용자는 065까지 적용했다고 보고했으므로 이 환경에서는 066부터 차례로 적용한다. SQL 095는 정책 확정 이후 별도 안전 설계를 거쳐 재검토한다.

당시 최신 순번: **095_crm14_block_customer_erasure.sql** — D-10 정책 결정 전 고객 영구 삭제를 차단합니다.

- `096_plan_file_storage_quotas.sql`: 요금제에 선택형 GiB 상한(최대 1,024 GiB)을 두고, 활성/체험 구독과 조직별 요청 한도 중 낮은 값으로 업로드를 제한한다. 값을 임의로 시드하지 않는다. Storage 객체 전체 사용량과 예약을 계속 포함하며, 초과 데이터는 보존하고 새 업로드만 차단한다. 요금제 전환과 예약은 조직 단위 advisory lock으로 직렬화한다.
- 적용 순서: **현재 최신 SQL → 096 → 관리자 API와 사용자 API 재시작 → 앱 갱신**. 앞 단계 적용 상태가 065라면 누락된 066~095를 먼저 차례로 적용한 뒤 096을 실행한다. 격리 DB 검증은 `pnpm --dir scripts/db-tests test:file-storage-plan-quota-096`이다. 적용 후 플랫폼 관리자 메뉴에서 각 플랜 용량을 설정할 수 있다. 공유 링크는 D-21 결정 대기다.

당시 최신 순번: **096_plan_file_storage_quotas.sql** — FILE-11 요금제별 저장 용량 상한을 추가합니다.

- `097_customer_retention_controls.sql`: CRM-014 조직별 데이터 분류 보유기간 설정(미설정은 NULL), 고객 관계 종료/재개 상태, 고객별 법적 보류 및 불변 이벤트를 추가한다. owner/admin만 전용 RPC로 변경할 수 있고 정책 버전 충돌을 막는다. 이 migration은 고객·거래·동의·사진·Storage 파일을 삭제하지 않으며 파기 RPC도 제공하지 않는다.
- 적용 순서: **현재 최신 SQL → 누락된 SQL 066~096 → 097 → API 재시작 → 앱 갱신**. 사용자가 예전에 065까지 적용했다고 보고했으며, 066~096의 원격 적용 여부는 이 작업에서 확인하지 않았다. 격리 DB는 `pnpm --dir scripts/db-tests test:customer-retention-097`, API는 고객 라우트 집중 테스트, 화면은 `CustomerRetentionDialog.test.tsx`를 실행한다. 실제 Supabase 적용 전 CRM 정책값 검토와 운영 인수가 남아 있다.

당시 최신 순번: **097_customer_retention_controls.sql** — CRM-014의 조직별 보유 정책·관계 종료·법적 보류 기반을 추가합니다.

- `098_supabase_security_advisor_hardening.sql`: anon/authenticated의 `public.rls_auto_enable()` 실행 권한을 회수하고, RPC 전용 내부 테이블 9개에 직접 클라이언트 접근 차단 정책을 추가한다. event trigger는 postgres 소유로 유지한다.
- 원격 적용을 2026-10-21 확인했다. 직접 권한 조회, 차단 정책 9개, event-trigger 자동 RLS smoke check가 통과했다. 재실행은 멱등적이다. 남은 advisor 경고와 한계는 [보안 감사](../docs/product/audits/2026-10-21-supabase-migration-and-security.md)에 기록한다.

당시 최신 순번: **098_supabase_security_advisor_hardening.sql** — 직접 DB 권한 경계를 강화합니다.

- `099_scope_organization_existence_to_membership.sql`: 로그인 사용자에게 임의 조직 UUID의 존재 여부가 노출되지 않도록 `organization_exists(uuid)`를 현재 사용자의 조직 멤버십 검사로 제한한다. 인증 사용자에게만 실행을 허용한다.
- 원격 적용은 2026-10-21 확인했다. owner 정상 멤버십은 `true`, 비회원이 실제 조직 UUID를 확인하면 `false`이며, 무JWT RPC/비회원 조직 RPC 거부는 롤백 트랜잭션으로 검사했다.

현재 최신 순번: **099_scope_organization_existence_to_membership.sql** — 조직 접근 존재 조회를 멤버십 범위로 한정합니다.
