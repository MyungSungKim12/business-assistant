# WAL-11 회원권 금액권 부분 환불 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 할인 후 판매 금액과 발급 금액이 일치하는 활성 금액 회원권에 외부 환불 완료액을 기록하고, 지갑 잔액·재무·수당 원장을 함께 조정한다.

**Architecture:** SQL 087에서 권한·버전·멱등성·마감 검사를 수행하는 보안 RPC와 불변 환불 원장을 추가한다. API gateway/route와 회원권 팝업은 같은 preview/record RPC를 사용하고, 수당 미리보기는 환불일 기준 음수 membership 거래를 읽는다.

**Tech Stack:** PostgreSQL/Supabase, Node.js/Fastify, TypeScript/Zod, React, PGlite, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-20-wallet-partial-refund-design.md`

## Global Constraints

- owner/admin만 환불을 미리 보고 기록한다.
- 재무 금액은 원 단위 문자열이며 음수·0·잘못된 금액을 허용하지 않는다.
- 보너스/할인 불일치, 횟수 혜택, 일시 정지, 만료 회원권은 추정 환불을 막는다.
- DB가 조직·권한·잔액 버전·작업 ID·월 마감·정산 기간을 재검사한다.
- 외부 결제 취소는 수행하지 않는다.
- 사용자 변경 및 현재 미커밋 소스를 보존하고 커밋/푸시는 하지 않는다.

## Review Focus

- 동시 요청으로 잔액이 음수가 되거나 두 번 환불되지 않아야 한다.
- 확정 수당 기간의 환불은 이전 확정 원장을 수정하지 않고 거절되어야 한다.
- 기존 방문 전체 취소와 환불 기능에 회귀가 없어야 한다.
- 환불에 실패하면 finance transaction과 잔액 변경도 함께 롤백되어야 한다.
- 수당 미리보기는 환불 건의 source line을 보존하고 member 권한의 조직 경계를 유지해야 한다.

---

### Task 1: DB 환불 원장과 RPC

**Files:**
- Create: `migrations/087_wallet_partial_refunds.sql`
- Modify: `scripts/db-tests/wallet-usage.mjs`
- Modify: `scripts/db-tests/package.json`
- Modify: `migrations/README.md`

**Interfaces:**
- `preview_wallet_purchase_refund(p_organization_id uuid,p_customer_id uuid,p_wallet_id uuid)` returns `{organization_id,customer_id,wallet_id,refund_cap,money_balance,balance_version,purchase_amount}`.
- `refund_wallet_purchase(p_organization_id uuid,p_customer_id uuid,p_wallet_id uuid,p_amount text,p_reason text,p_expected_balance_version bigint,p_operation_id uuid,p_confirmed boolean)` returns wallet, finance transaction ID, and event snapshot.

- [x] Test partial, full remaining balance, over-refund, unsupported benefit, version, replay/conflict, settlement period, role/org, and atomic transaction paths.
- [x] Run the initial focused PGlite test and observe the missing-RPC failure.
- [x] Implement immutable events, `wallet_balance_version`, `refunded` state, finance insertion, cap calculation, and RPC grant controls.
- [x] Re-run the focused PGlite test and migration reapply check.

### Task 2: API contract

**Files:**
- Modify: `apps/api/src/modules/catalog/routes.ts`
- Modify: `apps/api/src/modules/catalog/gateway.ts`
- Modify: `apps/api/src/modules/catalog/catalog.test.ts`

**Interfaces:**
- `GET /api/v1/organizations/:organizationId/customers/:customerId/wallets/:walletId/refund-preview`.
- `POST /api/v1/organizations/:organizationId/customers/:customerId/wallets/:walletId/refunds`.

- [x] Test schema bounds, manager-only authorization, RPC argument mapping, organization/customer/wallet response validation.
- [x] Run catalog API tests and confirm the missing-route behavior before implementation.
- [x] Implement both routes and gateway RPC mappings.
- [x] Re-run catalog API tests and API build.

### Task 3: Wallet activity and commission adjustment

**Files:**
- Modify: `migrations/087_wallet_partial_refunds.sql`
- Modify: `scripts/db-tests/wallet-usage.mjs`

- [x] Test that refund activity is added as a negative membership settlement line on refund date, with role and period rules.
- [x] Extend `private.staff_commission_preview` to include refund events tied to the original sale line.
- [x] Run focused wallet DB and catalog API tests.

### Task 4: React UI and documents

**Files:**
- Modify: `apps/desktop-react/src/features/catalog/WalletDialogs.tsx`
- Modify: `apps/desktop-react/src/features/catalog/api.ts`
- Modify: `apps/desktop-react/src/features/catalog/schemas.ts`
- Modify: `apps/desktop-react/src/features/catalog/catalog.test.tsx`
- Modify: `apps/desktop-react/src/features/catalog/catalog.css`
- Modify: `docs/product/backlog.md`
- Modify: `docs/product/menus/06-memberships-packages.md`
- Modify: `docs/product/pending-decisions-2026-10-14.md`
- Create: `docs/product/audits/2026-10-20-wallet-partial-refund.md`

- [x] Test preview, amount validation, confirmation, operation retry, unsupported wallet explanation and history display.
- [x] Implement a manager-only refund entry flow with an external-refund warning.
- [x] Run catalog React tests and build.
- [x] Record SQL 087 as pending Supabase and leave unsupported wallet refund policies open.
