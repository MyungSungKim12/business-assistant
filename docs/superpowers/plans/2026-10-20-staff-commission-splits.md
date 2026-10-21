# TEAM-11 Multi-staff Commission Allocation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allocate one sale line across multiple staff and settle each share under the staff member's effective commission rule.

**Architecture:** Migration 094 adds organization-scoped per-line basis-point shares and extends the existing idempotent cart-line mutation so staff splits save atomically with the legacy primary assignment. The settlement preview expands each payment line into staff shares before applying existing effective-dated rules; settlement history stays one row per event, sale line, and staff.

**Tech Stack:** Supabase SQL, Fastify API, React, Vitest, PGlite.

**Spec:** `docs/superpowers/specs/2026-10-20-staff-commission-splits.md`

## Global Constraints

- Shares total exactly 10,000 basis points and each employee share is positive.
- Only active staff in the same organization are eligible.
- Keep cart line primary staff compatibility and block edits after checkout.
- No manual commission amount/rate inputs or payroll/tax behavior.

## Review Focus

- 60/40 allocation of positive receipt, wallet use, and refund amounts; last employee gets the rounding remainder.
- Duplicate staff, inactive staff, other organization, missing staff, and shares not equal to 10,000 are rejected.
- Same operation retry is stable; stale cart version and conflicting operation id are rejected.
- Confirmed history is readable only to managers or the linked employee for that employee's own rows.
- Existing no-split 100% single-staff settlements remain unchanged.

### Task 1: SQL cart splits and settlement expansion

**Files:** Create `migrations/094_staff_commission_splits.sql`; modify/create focused `scripts/db-tests/commission-splits.mjs`.

- [x] Add failing tests for 60/40 save, event allocation, per-staff rules, invalid splits, retry, period confirmation and employee scope.
- [x] Run tests and verify they fail on the missing split contract.
- [x] Add constrained allocation table, immutable cart operation handling and split-aware preview/settlement.
- [x] Run the isolated PGlite suite.

### Task 2: API contract

**Files:** Modify catalog routes/gateway tests and line schemas as needed.

- [x] Add invalid-schema, role, organization, idempotency and response-scope tests.
- [x] Add strict mutation schema support for allocation lists and validate RPC outputs.
- [x] Run sales cart API tests and build.

### Task 3: Cart editor

**Files:** Modify sales API, types, `SalesPage.tsx`, `SalesPage.test.tsx`, `sales.css`.

- [x] Add tests for main staff + assistant percentages, 100% total validation, save, and invalid-share failure. Reload/failure recovery use the existing cart operation flow.
- [x] Add add/remove allocation rows and show per-line employee shares in cart details.
- [x] Run focused sales React tests and build.

### Task 4: Product records

**Files:** Update TEAM-11 menu/backlog, migration README, changelog and commission settlement audit.

- [x] Record focused test commands and SQL 094 pending remote application.
- [x] Keep payroll, tax and post-checkout correction out of scope.
