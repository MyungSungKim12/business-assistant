# 인증·조직·구독 마이그레이션

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
