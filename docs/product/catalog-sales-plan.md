# 상품·회원권 판매 연결 — 2026-10-06

승인된 순서: 상품 등록 → 회원권 상품 → 방문 장바구니 → 결제와 재고·혜택 연결 → 권한·오류 검증. 기존 베이지 UI와 수납 기능을 확장한다. 024~026 SQL은 사용자 적용 완료 보고를 받았으며 운영 DB 확인은 하지 않았다. 해당 파일을 변경하지 않고 027을 추가한다.

## 범위와 판단

- INV-001: 조직별 SKU, 이름, 판매가, 단위, 판매 중지, 버전 관리. 거래처/매입 단위 환산은 후속 범위.
- WAL-001: 회원권 판매가와 제공 금액·횟수를 별도 정의하고 판매 당시 조건을 장바구니에 고정한다. 제공 금액과 횟수가 모두 있으면 복합 혜택이다. 유효기간은 결제 완료일(서울 기준)부터 일수로 계산한다.
- SALE-001: 시술 외 상품·회원권 추가, 다른 방문에서 같은 상품 재판매 가능. 수량·가격 수정은 기존 관리 권한/버전 계약을 따른다.
- INV-002: 관리자의 사유 있는 입고와 결제 완료 판매 출고 원장. 수량은 이번 판매용 상품에서 정수 단위만 지원한다. 시술 소모량·반품·폐기는 후속 범위.
- WAL-004: 고객 보유 회원권과 발급 원장을 조회한다. 실제 차감·환불·연장(WAL-002/003)은 후속 범위로 유지한다.
- 재고 예약 없이 미수 판매를 만들지 않도록 실물 상품이 있는 방문은 전액 수납만 허용한다. 시술·회원권만 있으면 기존 부분 수납을 유지한다. 재고 부족이면 이번 수납과 모든 부수 효과를 함께 취소한다.
- 결제 완료와 재고 출고/회원권 발급은 같은 DB 트랜잭션이다. 원본 판매 행에 고유 연결하여 재시도 시 중복 반영하지 않는다. 이미 완료된 과거 방문에는 소급 발급하지 않는다.
- 관리자(owner/admin)만 수정하며 member는 조회한다. 조직 경계와 인증은 API와 DB 모두 검사한다. 기록은 삭제하지 않는다.

## 순차 구현 계획

1. DB: 새 027 SQL에 카탈로그·재고·회원권 원장, 관리자 RPC, 카트 추가 RPC, 결제 완료 트리거를 추가한다. 기존 수납 함수를 복제하지 않고 트리거에서 전액/재고를 검증한다. DB 격리 테스트로 권한·중복·충돌·롤백·과거 조건을 확인한다.
2. 서버: 상품 조회/저장/입고, 카트 상품 추가, 고객 회원권 조회 API. 엄격한 입력 검증과 사용자 토큰 RPC, 타 조직 응답 방어를 구현한다.
3. 데스크톱: 결제 장바구니에서 상품 관리·입고·선택·추가와 고객 회원권 조회 동선을 제공한다. 비동기 로딩, 실패 재시도, 미저장 보호, 읽기 전용을 포함한다.
4. 통합 검토: 서버/common·Qt 별도 테스트, DB 전체 회귀, 화면 렌더링, 문서에 검증 범위·운영 미검증·새 SQL 적용 순서를 기록한다.

## 고정 인터페이스

카탈로그 행: id, organization_id, sku, name, kind(product/membership), unit_name, sale_price(원 정수 문자열), benefit_money(원 정수 문자열), benefit_count(정수), valid_days(null 또는 1~3650), is_active, version, stock_quantity(정수).

RPC:
- list_catalog_products(p_organization_id) → 행 배열
- save_catalog_product(p_organization_id,p_product_id nullable,p_expected_version nullable,p_operation_id,p_values jsonb) → 행
- receive_catalog_stock(p_organization_id,p_product_id,p_quantity,p_reason,p_operation_id) → 행
- add_catalog_product_to_cart(p_organization_id,p_visit_id,p_product_id,p_expected_version,p_operation_id) → 기존 SaleCartBundle
- list_customer_wallets(p_organization_id,p_customer_id) → 배열. 행: id, organization_id, customer_id, product_id, sale_line_id, name_snapshot, money_balance, count_balance, valid_from(date), expires_on(nullable date, 당일 포함), source_snapshot, created_at.

API: GET/POST /organizations/{org}/catalog-products; PUT /catalog-products/{product}; POST /catalog-products/{product}/stock-receipts; POST /visits/{visit}/sale-cart/lines/catalog-product; GET /customers/{customer}/wallets. 저장 요청에 operation_id, 수정 시 expected_version, 입고 quantity/reason, 카트 추가 product_id/expected_version/operation_id.

보조 Python 3.12로 테스트하며 기본 Python 차단은 이번 범위에서 조사하지 않는다. 실 Supabase·실 Windows 검증을 대신한다고 표시하지 않는다. 커밋/푸시는 별도 요청이 없으므로 작업 트리에 보존한다.
