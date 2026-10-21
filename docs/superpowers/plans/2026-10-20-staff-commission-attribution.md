# TEAM-11 Commission Attribution Correction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow managers to correct missing staff attribution on commission lines with a required reason and immutable audit history.

**Architecture:** SQL 093 stores versioned current overrides and append-only events, exposing a manager-only idempotent RPC. The existing commission preview remains the authority for allocation and effective-dated rule calculation. API and React add a guarded correction path for missing-staff lines.

**Tech Stack:** PostgreSQL/Supabase SQL, Fastify, Zod, React, Vitest, PGlite.

**Spec:** `docs/superpowers/specs/2026-10-20-staff-commission-attribution.md`

## Global Constraints

- Do not mutate source sale lines or invent commission rates/amounts.
- Require organization manager authorization, reason, optimistic version and operation id.
- Never claim Supabase application or real-world acceptance from isolated tests.

## Review Focus

- Concurrent correction: stale version must fail.
- Replay/conflict: same operation returns same result; reused id with different input fails.
- Cross-organization employee or sale line: reject.
- Confirmed period: reject a correction that would rewrite a frozen settlement.
- Refund event: recalculate using the refund event date's effective rule.

### Task 1: SQL correction and recalculation

**Files:** Create `migrations/093_staff_commission_attribution.sql`; modify `scripts/db-tests/commission-settlements.mjs`.

- [x] Add isolated database cases for initial correction, replay, stale version, manager scope, immutable history, frozen settlement, active staff list and re-preview calculation.
- [x] Run the DB test before migration support and observe the expected missing-RPC failure.
- [x] Implement current override, immutable audit event, guarded RPC, manager-only active staff list and preview wrapper using existing commission rules.
- [x] Run `node scripts/db-tests/commission-settlements.mjs` and verify all cases pass.

### Task 2: API contract

**Files:** Modify `apps/api/src/modules/management/routes.ts`, `gateway.ts`, `management.test.ts`.

- [x] Add tests for valid RPC mapping, malformed reason/version, non-manager denial and cross-organization response rejection.
- [x] Add strict PATCH route and RPC gateway method with response validation plus manager-only staff lookup.
- [x] Run focused management API tests (17 passed).

### Task 3: Manager correction UI

**Files:** Modify `apps/desktop-react/src/features/management/commissionApi.ts`, `ManagementPage.tsx`, `management.css`, `ManagementPage.test.tsx`.

- [x] Add tests for visible correction controls only on unassigned/previously corrected rows, required reason, submit and re-preview.
- [x] Add employee lookup, correction controls and user-visible conflict/failure handling.
- [x] Run focused management React tests (18 passed) and API/React builds.

### Task 4: Product records

**Files:** Update TEAM-11 backlog, changelog, migration README and `docs/product/audits/2026-10-20-staff-commission-settlement.md`.

- [x] Record exact focused test commands/results and the SQL 093 remote-application limitation.
- [x] Keep payroll, tax, multi-assignee allocation and operational acceptance explicitly open.
