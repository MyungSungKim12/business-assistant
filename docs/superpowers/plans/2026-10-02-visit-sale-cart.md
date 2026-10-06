# SALE-001 방문별 결제 장바구니 구현 계획

> 실행 방식: 현재 세션에서 순차 구현. 사용자 요청에 따라 단계별 재확인은 하지 않는다.

**Spec:** `docs/superpowers/specs/2026-10-02-visit-sale-cart-design.md`

**목표:** 시술 결제 초안을 고객 방문별 장바구니로 가져와 검토하되 실제 수납·매출·재고·회원권 원장에는 영향을 주지 않는 DB/API/데스크톱 흐름을 완성한다.

**구조:** `customer_visits`가 방문 ID를 제공하고 `sale_carts`가 방문과 1:1로 연결된다. `sale_cart_lines`는 불변 시술 초안을 원천으로 참조하고 제거 이력을 보존한다. 모든 변경은 예상 버전과 operation ID를 받는 RPC에서 처리한다. 서버는 기능·조직·역할을 검사하고 데스크톱은 3열 작업 화면과 실패 복구를 제공한다.

**기술:** PostgreSQL/Supabase RLS·RPC, FastAPI/Pydantic/httpx, PySide6, pytest/pytest-qt, Node PGlite DB 계약 테스트.

## 전역 제약

- `treatment_sale_drafts`와 `finance_transactions`의 기존 의미를 변경하지 않는다.
- 이번 범위에서 생성 가능한 항목 원천은 `treatment_draft`뿐이다.
- 운영 DB 적용, 배포, push를 수행하지 않는다.
- 기존 작업 트리의 사용자 변경을 보존한다.
- 각 구현 단계는 실패하는 테스트를 먼저 확인한 후 최소 코드로 통과시킨다.
- 저장소 지침에 따라 사용자가 다시 요청하기 전에는 커밋하지 않는다.

## 파일 책임

- `migrations/024_visit_sale_carts.sql`: 방문·장바구니·항목·작업 영수증, RLS와 원자 RPC.
- `scripts/db-tests/visit-sale-carts.mjs`: 격리 DB의 범위·동시성·멱등성·합계 계약.
- `apps/server/src/business_assistant_server/adapters/supabase_sale_carts.py`: PostgREST/RPC 어댑터와 Pydantic 응답 모델.
- `apps/server/src/business_assistant_server/api/sale_carts.py`: 조직 범위 REST API, 권한, 안전한 오류 변환.
- `apps/desktop/src/business_assistant_desktop/api_client.py`: 방문·장바구니 HTTP 클라이언트 계약.
- `apps/desktop/src/business_assistant_desktop/sale_cart_page.py`: 3열 작업 화면, 비동기 로딩, 입력 보호와 재시도.
- `apps/desktop/src/business_assistant_desktop/finance_page.py`: 장바구니 진입점과 기존 원장 화면 연결.
- 각 계층의 대응 테스트 파일: 계약을 구현보다 먼저 고정한다.

## Task 1: DB 계약과 migration

**Files**

- Create: `migrations/024_visit_sale_carts.sql`
- Create: `scripts/db-tests/visit-sale-carts.mjs`
- Modify: `scripts/db-tests/package.json`
- Modify: `migrations/README.md`
- Test: `apps/server/tests/test_migration_contract.py`

1. migration 파일명, 네 테이블, RLS, 직접 쓰기 제한, 핵심 RPC 이름을 검사하는 Python 계약 테스트를 추가한다.
2. 테스트를 실행해 migration 부재로 실패하는지 확인한다.
   - Run: `.\.venv\Scripts\python.exe -m pytest apps/server/tests/test_migration_contract.py -q`
   - Expected: 새 visit sale cart 계약 테스트 FAIL.
3. 격리 DB 테스트에 방문+장바구니 원자 생성, 같은 operation 정확 재시도, 다른 payload 충돌, 시술 초안 중복 추가, 오래된 버전, 제거·복원, 조직/역할 거부, 합계 및 재무 원장 무변경 사례를 작성한다.
4. migration을 최소 구현해 Python 계약과 DB 테스트를 통과시킨다.
   - Run: `.\.venv\Scripts\python.exe -m pytest apps/server/tests/test_migration_contract.py -q`
   - Run: `npm --prefix scripts/db-tests run test:visit-sale-carts`
   - Expected: 모두 PASS.

## Task 2: 서버 저장소와 API

**Files**

- Create: `apps/server/src/business_assistant_server/adapters/supabase_sale_carts.py`
- Create: `apps/server/src/business_assistant_server/api/sale_carts.py`
- Create: `apps/server/tests/test_sale_cart_api.py`
- Create: `apps/server/tests/test_supabase_sale_cart_repository.py`
- Modify: `apps/server/src/business_assistant_server/main.py`

1. 가짜 저장소로 인증, `crm.basic`+`finance.basic`, 구성원 조회, owner/admin 변경, 조직 범위, 4xx/503 변환 테스트를 작성한다.
2. MockTransport로 모든 PostgREST/RPC 경로와 payload, Decimal 문자열 보존, operation ID 재전송 테스트를 작성한다.
3. 테스트를 실행해 모듈 부재 실패를 확인한다.
4. 모델·프로토콜·어댑터·라우터를 구현하고 앱에 등록한다.
5. 집중 테스트를 통과시킨다.
   - Run: `.\.venv\Scripts\python.exe -m pytest apps/server/tests/test_sale_cart_api.py apps/server/tests/test_supabase_sale_cart_repository.py -q`
   - Expected: PASS.

## Task 3: 데스크톱 API 계약

**Files**

- Modify: `apps/desktop/src/business_assistant_desktop/api_client.py`
- Modify: `apps/desktop/src/business_assistant_desktop/main_window.py`
- Create: `apps/desktop/tests/test_api_client_sale_carts.py`

1. 방문 목록/생성, 장바구니 조회, 초안 추가, 항목 수정·제거·복원, 검토 전환의 정확한 URL·인증·payload 테스트를 작성한다.
2. 테스트를 실행해 메서드 부재 실패를 확인한다.
3. `ApiClient`와 세션 바인딩 클라이언트에 메서드를 추가한다.
4. 집중 테스트를 통과시킨다.
   - Run: `.\.venv\Scripts\python.exe -m pytest apps/desktop/tests/test_api_client_sale_carts.py -q`
   - Expected: PASS.

## Task 4: 3열 장바구니 작업 화면

**Files**

- Create: `apps/desktop/src/business_assistant_desktop/sale_cart_page.py`
- Create: `apps/desktop/tests/test_sale_cart_page.py`
- Modify: `apps/desktop/src/business_assistant_desktop/finance_page.py`
- Modify: `apps/desktop/tests/test_finance_page.py`

1. 고객/방문/미사용 초안, 장바구니 항목/제거 이력, 합계/경고를 각각 렌더링하는 테스트를 작성한다.
2. 부분 로딩 실패가 성공한 열을 지우지 않는지, 저장 실패가 입력·operation ID를 보존하는지, 409가 덮어쓰기를 막는지 테스트한다.
3. 고객·방문·메뉴 이동과 종료에서 작성 중 입력 보호를 테스트한다.
4. 테스트 실패를 확인한 후 비동기 작업과 3열 화면을 구현한다.
5. 매출·지출 화면의 진입점을 새 작업 화면으로 연결하고 기존 시술 초안 조회 호환을 유지한다.
6. 집중 테스트를 통과시킨다.
   - Run: `.\.venv\Scripts\python.exe -m pytest apps/desktop/tests/test_sale_cart_page.py apps/desktop/tests/test_finance_page.py -q`
   - Expected: PASS.

## Task 5: 통합과 회귀 검증

**Files**

- Modify: `apps/desktop/tests/test_main_window.py`
- Modify: `scripts/preview-design.py`
- Create: `docs/screenshots/remodel-sale-cart-1100.png`
- Create: `docs/screenshots/remodel-sale-cart-1440.png`

1. entitlement에 따른 진입 가능/불가와 메뉴 이탈 보호 통합 테스트를 추가한다.
2. 1100×720 및 1440×920 오프스크린 렌더링을 생성해 글자 잘림, 3열 최소 너비, 포커스와 버튼 상태를 확인한다.
3. 전체 검증을 실행한다.
   - Run: `.\.venv\Scripts\python.exe -m pytest apps/desktop/tests -q`
   - Run: `.\.venv\Scripts\python.exe -m pytest apps/server/tests packages/common/tests -q`
   - Run: `.\.venv\Scripts\ruff.exe check apps/desktop/src apps/desktop/tests apps/server/src apps/server/tests`
   - Run: `.\.venv\Scripts\ruff.exe format --check apps/desktop/src apps/desktop/tests apps/server/src apps/server/tests`
   - Run: `git diff --check`
   - Expected: 모두 PASS.

## Task 6: 제품 기록 갱신

**Files**

- Modify: `docs/product/menus/05-payments-sales.md`
- Modify: `docs/product/changelog.md`
- Modify: `docs/product/roadmap.md`
- Create: `docs/product/visit-sale-cart-release.md`

1. 구현 범위, 실제 테스트 수, 화면 증거, migration 적용 순서와 제한을 기록한다.
2. SALE-001은 제품·회원권 마스터와 실환경 검증이 남으므로 `in-progress`를 유지한다.
3. 다음 단계는 SALE-002 복합 수납 원장으로 기록하되 장바구니를 확정 매출로 표현하지 않는다.

## Review Focus

- 장바구니 작업이 `finance_transactions`를 변경하거나 합계에 포함시키는 경로가 없는지
- 시술 초안 중복 추가와 operation ID 재시도가 동시 요청에서도 안전한지
- 조직·고객·방문·장바구니·원천 초안 범위가 모든 계층에서 일치하는지
- 실패·충돌·이탈 시 사용자가 작성한 값과 재시도 payload가 보존되는지
- 제거·복원 이력이 물리 삭제 없이 감사 가능하게 남는지

