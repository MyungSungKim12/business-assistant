# 문서 자동화 모듈 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 조직별 문서 템플릿과 텍스트 문서를 구독 권한으로 보호되는 CRUD API로 제공한다.

**Architecture:** FastAPI 문서 라우터가 인증·조직 멤버십·`document.template` 권한을 확인하고, publishable key와 현재 사용자 JWT를 사용하는 PostgREST 어댑터에 위임한다. Supabase migration은 두 테이블, 인덱스, 조직 멤버십 기반 RLS, 테넌트 변경 방지 트리거를 정의한다.

**Tech Stack:** Python 3.13, FastAPI, Pydantic v2, httpx, Supabase PostgREST, PostgreSQL RLS, pytest.

**Spec:** `docs/superpowers/specs/2026-09-16-document-automation-design.md`

## Global Constraints

- `document.template` 기능키가 없는 구독은 API에서 403을 반환한다.
- 모든 엔드포인트는 Bearer JWT와 조직 멤버십을 확인한다.
- Supabase publishable key와 현재 사용자 JWT만 사용하고 service role key는 데스크톱에 노출하지 않는다.
- 모든 테이블에 RLS를 활성화하고 조직 ID와 작성자는 UPDATE에서 변경할 수 없다.
- 생성·수정은 owner/admin만 허용하고 일반 member는 조회만 허용한다.
- 명시적 `null`, 빈 제목, 허용되지 않은 상태 값은 422로 거부한다.
- 파일 첨부, PDF·Word 변환, 공동 편집, 변경 이력은 이번 범위에 포함하지 않는다.

---

### Task 1: 문서 데이터베이스 마이그레이션

**Files:**
- Create: `migrations/007_documents.sql`
- Modify: `apps/server/tests/test_migration_contract.py`

**Interfaces:**
- Produces `public.document_templates` and `public.documents` tables, indexes, RLS policies, and tenant immutability triggers consumed by the repository and API.

- [ ] **Step 1: Write failing migration contract tests**

Add `_DOCUMENTS_PATH`, `_read_documents_migration()`, and tests asserting both tables, the status check constraint, organization indexes, RLS, member SELECT policies, owner/admin mutation policies, same-organization template validation, and `BEFORE UPDATE` triggers.

- [ ] **Step 2: Run migration tests to verify failure**

Run `uv run pytest apps/server/tests/test_migration_contract.py -q`. Expected: the new document contract tests fail because `007_documents.sql` does not exist.

- [ ] **Step 3: Write the migration**

Create the two organization-scoped tables with `uuid`, `timestamptz`, `not null default ''` text fields, indexes on `(organization_id, updated_at desc)`, RLS, member SELECT policies, owner/admin INSERT/UPDATE policies, and private trigger functions rejecting changes to `organization_id` and `created_by`. Add a trigger or policy condition ensuring a document's `template_id` belongs to the same organization.

- [ ] **Step 4: Run migration tests to verify pass**

Run `uv run pytest apps/server/tests/test_migration_contract.py -q`. Expected: all migration tests pass.

- [ ] **Step 5: Commit**

```powershell
git add migrations/007_documents.sql apps/server/tests/test_migration_contract.py
git commit -m "기능: 문서 템플릿과 문서 테이블 추가"
```

### Task 2: 문서 저장소 계약과 PostgREST 어댑터

**Files:**
- Modify: `apps/server/src/business_assistant_server/ports/repositories.py`
- Create: `apps/server/src/business_assistant_server/adapters/supabase_documents.py`
- Create: `apps/server/tests/test_supabase_document_repository.py`

**Interfaces:**
- `DocumentTemplateSummary` and `DocumentSummary` dataclasses expose UUIDs, organization IDs, author IDs, text fields, state, and timestamps.
- `DocumentRepository` exposes `list_templates`, `create_template`, `update_template`, `list_documents`, `create_document`, and `update_document` async methods.
- `SupabaseDocumentRepository(base_url, publishable_key, access_token, client=None)` sends organization-filtered PostgREST requests with `apikey` and the current bearer token.

- [ ] **Step 1: Write failing adapter tests**

Test that list/create/update requests include the organization filter, authorization headers, JSON serialization, template ID payloads, and that malformed HTTP/JSON responses become `RepositoryUnavailableError`.

- [ ] **Step 2: Run adapter tests to verify failure**

Run `uv run pytest apps/server/tests/test_supabase_document_repository.py -q`. Expected: import or interface failures because the document repository does not exist.

- [ ] **Step 3: Implement repository contracts and adapter**

Follow `SupabaseTaskRepository` patterns, use Pydantic row models for response validation, keep all queries scoped by organization ID, and return `None` for updates that affect no rows.

- [ ] **Step 4: Run adapter tests to verify pass**

Run `uv run pytest apps/server/tests/test_supabase_document_repository.py -q`. Expected: all adapter tests pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/business_assistant_server/ports/repositories.py apps/server/src/business_assistant_server/adapters/supabase_documents.py apps/server/tests/test_supabase_document_repository.py
git commit -m "기능: 문서 PostgREST 저장소 추가"
```

### Task 3: 문서 API와 권한·입력 검증

**Files:**
- Create: `apps/server/src/business_assistant_server/api/documents.py`
- Modify: `apps/server/src/business_assistant_server/main.py`
- Create: `apps/server/tests/test_document_api.py`

**Interfaces:**
- `GET/POST/PATCH /api/v1/organizations/{organization_id}/document-templates`
- `GET/POST/PATCH /api/v1/organizations/{organization_id}/documents`
- Request models reject empty titles, explicit nulls, unknown fields, invalid status values, and cross-organization template IDs.

- [ ] **Step 1: Write failing API tests**

Cover unauthenticated requests (401), non-members (403), missing `document.template` (403), member read access (200), owner/admin mutation access, invalid payloads (422), organization scoping (404/empty), and repository failures (503).

- [ ] **Step 2: Run API tests to verify failure**

Run `uv run pytest apps/server/tests/test_document_api.py -q`. Expected: module import or route failures.

- [ ] **Step 3: Implement Pydantic models, dependencies, and routes**

Reuse `get_current_user`, `require_feature`, `get_organization_repository`, and the bearer token dependency. Use `model_dump(mode="json", exclude_unset=True)` for PostgREST payloads. Return 404 when an update target is not in the requested organization and map repository failures to 503.

- [ ] **Step 4: Run API tests to verify pass**

Run `uv run pytest apps/server/tests/test_document_api.py -q`. Expected: all document API tests pass.

- [ ] **Step 5: Commit**

```powershell
git add apps/server/src/business_assistant_server/api/documents.py apps/server/src/business_assistant_server/main.py apps/server/tests/test_document_api.py
git commit -m "기능: 문서 템플릿과 문서 API 추가"
```

### Task 4: 메뉴 문서와 전체 검증

**Files:**
- Modify: `docs/03-menu-modules.md`
- Modify: `README.md`
- Create: `document-module-report.md`

**Interfaces:**
- Documentation marks document automation as implemented for `document.template`, while file/PDF automation remains planned.

- [ ] **Step 1: Update documentation**

Record the endpoints, migration order, feature key, and local verification command. Update the roadmap checklist to mark document automation complete and keep later modules unchecked.

- [ ] **Step 2: Run the complete verification suite**

Run `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check.ps1`, `uv run python -c "import supabase; print(supabase.__version__)"`, and `git diff --check`. Expected: formatting, Ruff, mypy, all tests, Supabase import, and diff checks pass.

- [ ] **Step 3: Write the implementation report**

Record the migration, API routes, security behavior, test count, and explicitly excluded follow-up features in `document-module-report.md`.

- [ ] **Step 4: Commit and push**

```powershell
git add README.md docs/03-menu-modules.md document-module-report.md
git commit -m "문서: 문서 자동화 모듈 구현 결과 정리"
git push origin main
```

