# LAB-10 경영 손익 확정 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete LAB-10 with manager-confirmed immutable, versioned snapshots of fully costed management profit.

**Architecture:** SQL 089 exposes a manager-only, idempotent RPC that rechecks the live management preview, persists an immutable snapshot and appends an audit event. Fastify validates the request and response; React adds an explicit completeness confirmation, finalization history and revision display.

**Tech Stack:** PostgreSQL/Supabase RPC, PGlite migration tests, Fastify/Zod API, React/Vitest.

**Spec:** [LAB-10 profit finalization design](../specs/2026-10-20-management-profit-finalization-design.md)

## Global Constraints

- Do not alter customer or appointment records.
- Finalize only periods with known inventory costs and full commission coverage.
- Record snapshots and audit events immutably; revisions append instead of replacing.
- Use only recorded money values; label the result as a manager-confirmed management snapshot, not a tax or statutory statement.
- Do not commit, push, apply Supabase SQL, or change real data.

## Review Focus

- Missing product or treatment costs block finalization.
- Partial date coverage by commission settlements blocks finalization.
- An ordinary member or another organization cannot read or finalize a snapshot.
- Replaying the same operation ID is idempotent; reusing it for different parameters conflicts.
- New revisions preserve earlier immutable values and record an audit event.

---

### Task 1: SQL snapshot and RPC

**Files:** Create `migrations/089_management_profit_finalization.sql`; modify `scripts/db-tests/management-recorded-tax.mjs` or add `scripts/db-tests/management-profit-finalization.mjs` and register a focused package script.

**Interfaces:** `public.finalize_management_profit(uuid,date,date,uuid,boolean,text)` returns a snapshot JSON object. `public.list_management_profit_finalizations(uuid,date,date)` returns revisions ordered newest first.

- [x] Add a failing isolated PostgreSQL test for success, preconditions, roles, tenant boundary, retry, conflict, revisions, audit, and immutability.
- [x] Run it and confirm the missing RPC causes the expected failure.
- [x] Implement the append-only table, RPCs, audit entry, constraints and grants.
- [x] Rerun the focused isolated database test; SQL is intentionally not applied to Supabase.

### Task 2: API contract

**Files:** Modify `apps/api/src/modules/management/gateway.ts`, `apps/api/src/modules/management/routes.ts`, `apps/api/src/modules/management/management.test.ts`.

**Interfaces:** Add POST `/management-profit-finalizations` and GET `/management-profit-finalizations?from_date=&to_date=`. Both are owner/admin-only; POST requires period, operation ID, completeness confirmation and an amendment reason when a prior revision exists.

- [x] Add failing route/gateway cases for invalid input, member rejection, wrong-org response, retry and amendment reason.
- [x] Implement gateway schemas/RPC calls and route access checks.
- [x] Run focused API tests and API build.

### Task 3: React confirmation and history

**Files:** Create `apps/desktop-react/src/features/management/profitApi.ts`; modify `ManagementPage.tsx`, `ManagementPage.test.tsx`, `management.css`.

- [x] Add failing tests for incomplete-period disabled state, exact confirmation checklist, successful snapshot, history revisions and retryable errors.
- [x] Implement the section and keep preview/final snapshot labels distinct.
- [x] Run focused management tests and React build.

### Task 4: Documentation and verification

**Files:** Modify product backlog, roadmap, changelog, menu 12, migration README, and the LAB-10 audit.

- [x] Record exact SQL order and the manager-confirmed scope and limitation.
- [x] Run SQL 089 isolated test, focused API/React tests, both package builds, and `git diff --check`.
