# 시술 소모품·회원권 연동 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Keep changes in the existing main workspace to preserve the user's uncommitted documentation edits and project main-only workflow.

**Goal:** 서비스별 소모품을 시술 완료 시 재고 원장에 원자적으로 반영하고, 이미 구현된 회원권 횟수 차감 UI를 실제 방문 매출 화면에서 사용할 수 있게 한다.

**Architecture:** React/Tauri 화면은 기존 Fastify API를 호출하고 API는 사용자 토큰으로 Supabase RPC를 사용한다. 새 SQL 마이그레이션은 서비스 소모품 기준과 시술 완료 재고 차감 트리거를 추가한다. 재고 차감은 시술 상태 변경과 같은 PostgreSQL 트랜잭션 안에서 수행한다.

**Tech Stack:** React 19, TypeScript, Fastify, zod, Supabase PostgreSQL/PostgREST, vitest.

**Spec:** `docs/superpowers/specs/2026-10-14-treatment-consumables-design.md`

## Global Constraints

- 조직 ID, 기능 권한, 역할을 API와 DB에서 검증한다.
- 기존 원장은 수정·삭제하지 않는다. 재고 부족이면 완료를 거부하고 상태와 재고 모두 보존한다.
- 기존 시술에는 소급 차감하지 않는다. 서비스 연결과 레시피가 있는 신규 완료에만 적용한다.
- 회원권은 매출/수납에서 한 번만 차감한다. 시술 완료에서 중복 차감하지 않는다.
- 기존 사용자 변경을 보존하고 커밋·푸시·실 DB 변경은 하지 않는다.
- 사용자가 요청한 범위에 맞춰 기능별 테스트만 실행하고 전체 테스트 스위트는 실행하지 않는다.

## Review Focus

- 완료 전 재고 부족·동시 요청에서 treatment status, product stock, ledger rows가 모두 원자적으로 유지되는지.
- 타 조직 service/product ID가 레시피·시술 연결·소모 원장에 섞이지 않는지.
- 네트워크 오류 재시도와 같은 operation ID가 중복 소모를 만들지 않는지.
- 비활성·정지 서비스 및 회원권이 신규 사용에 잘못 적용되지 않는지.
- 변경된 완료 기록의 정정·중단 흐름이 소비 원장을 조용히 변경하지 않는지.

---

### Task 1: SQL recipe and atomic consumption

**Files:**
- Create: `migrations/046_treatment_consumables.sql`
- Modify: `apps/api/src/migrations.contract.test.ts`
- Modify: `migrations/README.md`
- Test: `apps/api/src/migrations.contract.test.ts`

- [x] Add a focused isolated PostgreSQL test that executes 046 and fails on recipe save, organization/role boundaries, atomic deduction, idempotent retry, and no retroactive deduction.
- [x] Run it before and after the SQL fix; it first exposed the ambiguous `product_id` reference in the actual RPC.
- [x] Add service consumable recipe storage/RPC, treatment association field/RPC, and completion trigger in migration 046. Keep all inventory updates in the completion transaction; lock products in stable UUID order.
- [x] Run the same focused contract tests and confirm they pass.
- [x] Document migration 046 after 045 and the outstanding real-DB limitation.

### Task 2: API contracts and service association

**Files:**
- Modify: `apps/api/src/modules/appointment-resources/routes.ts`, `gateway.ts`, tests
- Modify: `apps/api/src/modules/treatments/routes.ts`, `gateway.ts`, `schemas.ts`, tests
- Modify: `apps/desktop-react/src/features/appointment-resources/api.ts`, `schemas.ts`
- Modify: `apps/desktop-react/src/features/treatments/api.ts`, `schemas.ts`

- [x] Add route/gateway tests for set/list service consumables and treatment service assignment with role, organization, schema, version, and database error checks.
- [x] Run the focused API tests; all covered contract paths pass.
- [x] Implement API validation and user-token RPC adapters.
- [x] Run focused API tests and confirm they pass.

### Task 3: React service recipe, treatment link, and wallet workflow

**Files:**
- Modify: `apps/desktop-react/src/features/catalog/ServicePage.tsx` and tests
- Modify: `apps/desktop-react/src/features/treatments/TreatmentPage.tsx` and tests
- Modify: `apps/desktop-react/src/features/sales/SalesPage.tsx` and tests
- Modify: `apps/desktop-react/src/features/catalog/WalletDialogs.tsx` only if required

- [x] Add regression coverage for service recipe editing and save failure input retention; existing focused tests cover treatment service linking and wallet usage from a visit.
- [x] Run focused UI tests; failure exposed a stale React event `currentTarget` access in recipe input, fixed without changing layout or style.
- [x] Implement the UI using existing modal, select, dirty-state, and operation recovery conventions.
- [x] Run the focused feature tests and confirm they pass (2026-10-14: ServicePage, TreatmentPage, SalesPage — 46 tests passed).

### Task 4: Status and final focused verification

**Files:**
- Modify: `docs/product/backlog.md`, relevant menu plan, and `docs/product/changelog.md`
- Test: impacted API and React files only

- [x] Mark TRT-11 in progress pending 실계정 권한별 업무 인수; 사용자는 046 Supabase SQL 적용 성공을 보고했다.
- [x] Run focused API/UI/isolated PostgreSQL tests, API build, React build, and `git diff --check`; do not run the full suite.
- [x] Review organization boundaries, cancellation/retry, input protection, and ledger atomicity against the spec.
