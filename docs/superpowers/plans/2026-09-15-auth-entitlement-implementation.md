# 인증·조직·구독 권한 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Supabase Auth 사용자 세션과 조직별 구독 기능을 FastAPI와 PySide6 메뉴에 연결한다.

**Architecture:** 서버는 AuthPort로 토큰을 검증하고 OrganizationRepository와 EntitlementService를 통해 조직 권한을 계산한다. 데스크톱 앱은 서버가 반환한 기능 코드만 사용해 메뉴를 활성화하며, 데이터베이스는 Supabase PostgreSQL의 RLS로 조직 경계를 보조한다.

**Tech Stack:** Python 3.13, uv, FastAPI, Pydantic Settings, SQLAlchemy 2.x, Alembic, Supabase Auth/PostgreSQL, PySide6, pytest, HTTPX.

**Spec:** `docs/superpowers/specs/2026-09-15-auth-entitlement-design.md`

## Global Constraints

- 데스크톱 앱은 Supabase 데이터베이스에 직접 연결하지 않는다.
- 모든 보호된 FastAPI 요청은 Bearer access token을 검증한다.
- `service_role`/secret key와 DB 비밀번호는 서버 전용이며 `.env`에만 둔다.
- 조직 역할과 구독 권한을 `user_metadata`에 저장하지 않는다.
- `public` 스키마 애플리케이션 테이블에는 RLS를 활성화한다.
- RLS 정책은 `TO authenticated`와 소유·멤버십 조건을 함께 사용한다.
- 모든 새 동작은 실패하는 테스트를 먼저 작성한 뒤 구현한다.
- 커밋 제목과 본문은 한글로 작성한다.

### Task 1: 공통 인증·권한 계약과 서버 설정

**Files:**
- Create: `packages/common/src/business_assistant_common/auth.py`
- Modify: `packages/common/src/business_assistant_common/entitlements.py`
- Modify: `apps/server/src/business_assistant_server/config.py`
- Modify: `apps/server/src/business_assistant_server/ports/auth.py` (기존 포트 확장)
- Test: `packages/common/tests/test_auth.py`
- Test: `apps/server/tests/test_config.py`
- Test: `apps/server/tests/test_ports.py`

**Interfaces:**
- `AuthUser(user_id: UUID, email: str, display_name: str | None)`
- `AuthSession(user: AuthUser, access_token: str, refresh_token: str | None)`
- `AuthPort.verify_access_token(access_token: str) -> AuthUser`
- `Settings.supabase_url`, `Settings.supabase_publishable_key`, `Settings.supabase_service_key`

- [ ] **Step 1: Write failing tests**

  `test_auth.py`에서 세션 모델의 필드와 `EntitlementSet`의 정렬된 직렬화를 검증한다. `test_config.py`에서 `APP_SUPABASE_PUBLISHABLE_KEY`가 설정으로 읽히는 테스트를 추가한다. `test_ports.py`에서 fake auth adapter가 `AuthPort` 프로토콜을 만족하는지 검증한다.

- [ ] **Step 2: Run targeted tests and verify expected failure**

  Run: `uv run pytest packages/common/tests/test_auth.py apps/server/tests/test_config.py apps/server/tests/test_ports.py -q`

  Expected: 새 모델·설정 필드가 없어 실패한다.

- [ ] **Step 3: Implement minimal contracts**

  UUID 기반 불변 데이터 모델과 포트 프로토콜을 추가하고, 설정에 publishable key를 추가한다. 기존 health API와 포트의 동작은 변경하지 않는다.

- [ ] **Step 4: Run targeted tests and verify pass**

  Run: `uv run pytest packages/common/tests/test_auth.py apps/server/tests/test_config.py apps/server/tests/test_ports.py -q`

  Expected: 새 테스트와 기존 대상 테스트가 모두 통과한다.

- [ ] **Step 5: Commit**

  `git add packages/common apps/server && git commit -m "기능: 인증과 권한 공통 계약 추가"`

### Task 2: PostgreSQL 스키마·RLS·기본 상품 데이터

**Files:**
- Create: `migrations/001_auth_entitlements.sql`
- Create: `migrations/002_seed_entitlements.sql`
- Create: `migrations/README.md`
- Create: `apps/server/tests/test_migration_contract.py`

**Interfaces:**
- Tables: `profiles`, `organizations`, `memberships`, `features`, `plans`, `plan_features`, `subscriptions`
- Seed plans: `BASIC`, `STANDARD`, `PRO`
- Seed feature codes: `dashboard.basic`, `crm.basic`, `document.template`, `data.basic`, `reports.basic`, `automation.custom`, `ai.summary`

- [ ] **Step 1: Write failing migration contract tests**

  Migration contract tests는 SQL 파일에 모든 테이블명, 외래 키, unique 제약, `enable row level security`, 기본 feature code가 포함되는지 검증한다. 테스트는 SQL 실행 없이도 누락된 보안 선언을 잡는다.

- [ ] **Step 2: Run tests and verify failure**

  Run: `uv run pytest apps/server/tests/test_migration_contract.py -q`

  Expected: 마이그레이션 파일이 없어 실패한다.

- [ ] **Step 3: Write migrations**

  `uuid`, `timestamptz`, `text`, `integer`, `boolean` 타입을 사용하고 모든 FK에 인덱스를 둔다. `memberships`는 조직·사용자 복합 unique를 갖는다. 각 public 테이블에 RLS를 켜고, 멤버십 기반 select 정책과 owner/admin 관리 정책을 추가한다. `plan_features`와 활성 구독 조회에 필요한 인덱스를 포함한다.

- [ ] **Step 4: Run contract tests and SQL lint checks**

  Run: `uv run pytest apps/server/tests/test_migration_contract.py -q` and `rg -n "service_role|user_metadata|auth\.role\(\)" migrations`

  Expected: 테스트 통과 및 금지된 권한 패턴 미검출.

- [ ] **Step 5: Commit**

  `git add migrations apps/server/tests/test_migration_contract.py && git commit -m "데이터: 인증과 구독 권한 스키마 추가"`

### Task 3: 인증 어댑터와 FastAPI 인증 API

**Files:**
- Create: `apps/server/src/business_assistant_server/adapters/supabase_auth.py`
- Create: `apps/server/src/business_assistant_server/dependencies/auth.py`
- Create: `apps/server/src/business_assistant_server/api/auth.py`
- Modify: `apps/server/src/business_assistant_server/main.py`
- Test: `apps/server/tests/test_auth_api.py`
- Test: `apps/server/tests/test_auth_dependencies.py`

**Interfaces:**
- `SupabaseAuthAdapter.sign_up(email: str, password: str, display_name: str) -> AuthSession`
- `SupabaseAuthAdapter.sign_in(email: str, password: str) -> AuthSession`
- `SupabaseAuthAdapter.refresh(refresh_token: str) -> AuthSession`
- `get_current_user(authorization: HTTPAuthorizationCredentials) -> AuthUser`
- Routes: `POST /api/v1/auth/signup`, `/login`, `/refresh`, `GET /api/v1/me`

- [ ] **Step 1: Write failing API tests**

  HTTPX ASGI 테스트에서 로그인 성공 응답, 잘못된 자격 증명 `401`, Bearer 토큰 없는 `/me` `401`, fake adapter를 통한 `/me` 성공을 정의한다.

- [ ] **Step 2: Run tests and verify failure**

  Run: `uv run pytest apps/server/tests/test_auth_api.py apps/server/tests/test_auth_dependencies.py -q`

  Expected: 라우터와 인증 의존성이 없어 실패한다.

- [ ] **Step 3: Implement adapter boundary and routes**

  외부 Supabase 호출은 adapter 안에 둔다. HTTP 오류를 내부 예외로 변환하고 API에서는 일관된 `401` 응답을 반환한다. `create_app()`에 auth router를 등록하고 테스트에서는 dependency override로 fake adapter를 주입한다.

- [ ] **Step 4: Run API tests and full server tests**

  Run: `uv run pytest apps/server/tests -q`

  Expected: 인증 테스트와 기존 health/config/port 테스트가 모두 통과한다.

- [ ] **Step 5: Commit**

  `git add apps/server && git commit -m "기능: Supabase 인증 API 연결"`

### Task 4: 조직·멤버십·구독 entitlement 서비스와 API

**Files:**
- Create: `apps/server/src/business_assistant_server/domain/organizations.py`
- Create: `apps/server/src/business_assistant_server/domain/entitlements.py`
- Create: `apps/server/src/business_assistant_server/ports/repositories.py`
- Create: `apps/server/src/business_assistant_server/api/organizations.py`
- Create: `apps/server/src/business_assistant_server/api/entitlements.py`
- Modify: `apps/server/src/business_assistant_server/main.py`
- Test: `apps/server/tests/test_organization_service.py`
- Test: `apps/server/tests/test_entitlement_api.py`

**Interfaces:**
- `OrganizationService.create_organization(user_id: UUID, name: str, slug: str) -> OrganizationSummary`
- `OrganizationService.list_for_user(user_id: UUID) -> list[OrganizationSummary]`
- `EntitlementService.get_active_entitlements(user_id: UUID, organization_id: UUID) -> EntitlementResponse`
- `require_feature(feature_code: str)` FastAPI dependency factory
- Routes: `POST/GET /api/v1/organizations`, `GET /api/v1/organizations/{id}/members`, `GET /api/v1/organizations/{id}/entitlements`, `GET /api/v1/organizations/{id}/subscriptions/current`

- [ ] **Step 1: Write failing domain and API tests**

  테스트에서 owner만 조직을 만들 수 있는 초기 흐름, 비멤버 `403`, 구독 없는 조직의 빈 entitlement, BASIC 플랜의 feature 목록, 없는 feature에 대한 `403`을 정의한다.

- [ ] **Step 2: Run tests and verify failure**

  Run: `uv run pytest apps/server/tests/test_organization_service.py apps/server/tests/test_entitlement_api.py -q`

  Expected: repository ports와 서비스 구현이 없어 실패한다.

- [ ] **Step 3: Implement repositories and services**

  repository protocol은 사용자·멤버십·활성 구독 조회와 조직 생성을 정의한다. 기본 테스트는 in-memory fake repository를 사용한다. 활성 구독 판정은 `trialing`/`active`이며 종료 시각이 없거나 미래인 경우로 고정한다. `require_feature`는 멤버십과 entitlement를 모두 확인한다.

- [ ] **Step 4: Implement API routers and run tests**

  API 응답 모델을 명시하고 `401/403/404`를 구분한다. Run: `uv run pytest apps/server/tests -q`

  Expected: 전체 서버 테스트 통과.

- [ ] **Step 5: Commit**

  `git add apps/server && git commit -m "기능: 조직과 구독 권한 API 추가"`

### Task 5: 데스크톱 로그인 세션과 entitlement 메뉴 연동

**Files:**
- Create: `apps/desktop/src/business_assistant_desktop/session.py`
- Create: `apps/desktop/src/business_assistant_desktop/api_client.py`
- Modify: `apps/desktop/src/business_assistant_desktop/app.py`
- Modify: `apps/desktop/src/business_assistant_desktop/main_window.py`
- Modify: `apps/desktop/tests/test_main_window.py`
- Create: `apps/desktop/tests/test_session.py`
- Create: `apps/desktop/tests/test_api_client.py`

**Interfaces:**
- `Session(access_token: str, refresh_token: str | None, user_id: UUID)`
- `ApiClient.login(email: str, password: str) -> Session`
- `ApiClient.get_entitlements(organization_id: UUID, session: Session) -> EntitlementSet`
- `MainWindow(entitlements: EntitlementSet)` 유지

- [ ] **Step 1: Write failing client/session tests**

  로그인 응답을 Session으로 변환하는 동작, Bearer 헤더 생성, entitlement 응답을 `EntitlementSet`으로 변환하는 동작, 기능이 없을 때 메뉴 비활성화를 정의한다.

- [ ] **Step 2: Run tests and verify failure**

  Run: `uv run pytest apps/desktop/tests -q`

  Expected: session/API client 모듈이 없어 실패한다.

- [ ] **Step 3: Implement minimal client and session**

  HTTP 호출은 `httpx.Client` 경계에 두고, access token은 메모리에만 보관한다. 앱 시작 시 개발용 기본 entitlement를 사용하는 현재 동작은 유지하되, 로그인 성공 후 서버 entitlement를 주입할 수 있도록 `MainWindow` 생성 경로를 분리한다.

- [ ] **Step 4: Run desktop tests and full checks**

  Run: `uv run pytest apps/desktop/tests -q` and `powershell -ExecutionPolicy Bypass -File scripts/check.ps1`

  Expected: 데스크톱 테스트와 전체 Ruff/mypy/pytest 통과.

- [ ] **Step 5: Commit**

  `git add apps/desktop && git commit -m "기능: 데스크톱 인증과 메뉴 권한 연동"`

### Task 6: 운영 설정·문서·최종 검증

**Files:**
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `docs/05-development-guide.md`
- Create: `docs/08-supabase-setup.md`
- Modify: `scripts/check.ps1`
- Test: `apps/server/tests/test_config.py`

**Interfaces:**
- 설정 항목: `APP_SUPABASE_URL`, `APP_SUPABASE_PUBLISHABLE_KEY`, `APP_SUPABASE_SERVICE_KEY`
- 문서에는 실제 비밀값을 포함하지 않는다.

- [ ] **Step 1: Write failing configuration/document checks**

  설정 테스트에서 publishable key 이름을 고정하고, 문서 검사에서 `.env`를 Git에 추가하지 않는 안내와 Supabase 키 분리를 확인한다.

- [ ] **Step 2: Run checks and verify failure**

  Run: `uv run pytest apps/server/tests/test_config.py -q`

  Expected: 새 문서·설정 계약이 반영되지 않아 실패하거나 현재 상태를 확인한다.

- [ ] **Step 3: Update docs and scripts**

  Supabase 프로젝트 생성부터 로컬 `.env` 입력, 마이그레이션 적용, 테스트 실행 순서를 한국어로 작성한다. 서비스 키 노출 금지와 RLS 원칙을 강조한다.

- [ ] **Step 4: Run complete verification**

  Run: `powershell -ExecutionPolicy Bypass -File scripts/check.ps1` and `git diff --check`

  Expected: Ruff, mypy, pytest가 모두 성공하고 diff 공백 오류가 없다.

- [ ] **Step 5: Commit and prepare push**

  `git add .env.example README.md docs scripts && git commit -m "문서: Supabase 인증 권한 설정 안내 추가"`

  이후 `git status --short`와 `git log --oneline -6`을 확인하고 사용자에게 main push 여부를 보고한다.
