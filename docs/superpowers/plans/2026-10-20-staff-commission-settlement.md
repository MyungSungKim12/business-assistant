# TEAM-11 수당 정산 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 수납·할인·반품·환불을 추적 가능한 직원 수당 명세와 잠금된 기간 정산으로 연결한다.

**Architecture:** SQL 079가 라인 배분 원장과 정산 RPC/RLS를 소유한다. Node API는 검증된 RPC를 노출하고 직원 화면은 관리자 검토·확정과 직원 자기 명세 조회를 제공한다. 가상 PostgreSQL은 할인·부분 수납·환불 및 역할 격리를 검증한다.

**Tech Stack:** PostgreSQL/Supabase RPC, Fastify/TypeScript, React 19, Vitest, PGlite.

**Spec:** `docs/superpowers/specs/2026-10-20-staff-commission-settlement.md`

## Global Constraints

- 수당 기준은 수납일의 유효 `net_paid` 정률이다.
- 정확한 조직·직원 범위를 API와 DB에서 모두 검사한다.
- 확정 내역·수납 분배·감사 이벤트는 불변이다.
- 기존 작업 트리를 보존하고 커밋/푸시는 하지 않는다.
- 전체 테스트와 실 Supabase 인수는 실행하지 않는다.

## Review Focus

- 할인/다중 라인/부분 결제의 원 단위 배분합은 각 원장의 합계와 정확히 같다. (DB test)
- 반품과 일반 환불을 중복 차감하지 않고 초과 차감도 만들지 않는다. (DB test)
- 직원 전용 규칙은 기본 규칙과 합산하지 않고 누락 대상은 미배정으로 남긴다. (DB/API/UI)
- 다른 조직·비관리자·다른 직원은 미리보기/확정 명세에 접근할 수 없다. (DB/API)
- 오래 열린 기간을 동시에 확정하거나 과거에 확정 내역을 덮어쓸 수 없다. (DB test)

---

### Task 1: SQL 수당 배분·정산 원장

**Files:**
- Create: `migrations/079_staff_commission_settlements.sql`
- Modify: `scripts/db-tests/package.json`
- Create: `scripts/db-tests/commission-settlements.mjs`
- Modify: `migrations/README.md`

**Interfaces:** Preview RPC returns period, employee, totals, line-level allocation, rule snapshot, and unassigned rows. Confirm RPC accepts period, staff, expected version and operation ID and returns an immutable settlement. Self list RPC returns only confirmed settlements for the linked staff user.

- [ ] PGlite tests first for discount/payment/refund allocations, rule precedence, confirm retry, overlap/stale periods, and role/tenant boundaries.
- [ ] Run the focused test and confirm expected failures.
- [ ] Implement 079 schema, RLS, immutable triggers and owner/admin/self RPCs.
- [ ] Run `npm run test:staff-commissions --prefix scripts/db-tests`.

### Task 2: Node API

**Files:**
- Modify: `apps/api/src/modules/management/gateway.ts`
- Modify: `apps/api/src/modules/management/routes.ts`
- Modify: `apps/api/src/modules/management/management.test.ts`

- [ ] Add strict schemas/routes for preview, confirm and own/manager settlement list.
- [ ] Add member denial, malformed input, organization mismatch and response validation tests.
- [ ] Run focused API tests and API build.

### Task 3: React review and employee statement

**Files:**
- Create: `apps/desktop-react/src/features/catalog/CommissionSettlementsDialog.tsx`
- Modify: `apps/desktop-react/src/features/catalog/StaffPage.tsx`
- Modify: `apps/desktop-react/src/features/catalog/StaffProfileDialog.tsx` (own statement link where session user matches account)
- Modify: `apps/desktop-react/src/features/management/commissionApi.ts`
- Modify: `apps/desktop-react/src/features/catalog/catalog.test.tsx`

- [ ] Admin previews and confirms a closed period with per-line evidence and unassigned warnings.
- [ ] Linked staff sees only their confirmed statements and adjustments; no other employee data.
- [ ] Run focused React tests and build.

### Task 4: Product record and final profit

**Files:**
- Modify: `docs/product/pending-decisions-2026-10-14.md`
- Modify: `docs/product/backlog.md`
- Modify: `docs/product/menus/08-staff-commissions.md`
- Modify: `docs/product/menus/09-expenses-settlement-profit.md`
- Modify: `docs/product/project-status-2026-10-20.md`
- Modify: `docs/product/roadmap.md`
- Modify: `docs/product/changelog.md`
- Create: `docs/product/audits/2026-10-20-staff-commission-settlements.md`

- [ ] Record the calculation choice and limitations.
- [ ] Make LAB-10 include confirmed commission settlements only and continue to exclude tax/unconfirmed costs.
- [ ] Run only focused management tests/build; no full suite or real DB.
