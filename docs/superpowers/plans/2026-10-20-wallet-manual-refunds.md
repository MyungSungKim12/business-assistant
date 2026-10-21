# WAL-11 관리 입력형 회원권 환불 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 할인·횟수·복합 회원권의 실제 환불액과 회수할 혜택을 별도 입력해 원자 기록한다.

**Architecture:** SQL 092에 독립 환불 금액/혜택 제거 필드를 갖춘 멱등 RPC를 추가하고, 기존 이력/수당 결과를 확장한다. Fastify 검증과 React 관리자 입력에서 각 값을 그대로 전달한다.

**Tech Stack:** PostgreSQL/Supabase RPC, Node.js Fastify, React, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-20-wallet-manual-refunds.md`

## Global Constraints
- 외부 환불 금액과 제거 혜택을 절대 자동 환산하지 않는다.
- 조직 및 관리자 검사, 잔액 버전, 멱등성, 원자성, 불변 이력을 보존한다.
- 이미 존재하는 미커밋 변경을 보존하고 요청 없이 커밋/푸시하지 않는다.

## Review Focus
- 외부 환불액 누계가 원 결제액을 초과할 때 거절하는 DB 테스트.
- 제거할 금액/횟수가 잔액을 초과할 때 거절하는 DB 테스트.
- 외부 환불액과 제거 혜택이 다른 값이어도 각각 올바른 원장에 남는 DB 테스트.
- API에서 누락/음수/잘못된 확인 값이 422인 계약 테스트.
- 재시도 시 중복 환불·재무 지출이 없는 DB 테스트.

---

### Task 1: API 환불 입력 계약

**Files:**
- Modify: `apps/api/src/modules/catalog/routes.ts`
- Modify: `apps/api/src/modules/catalog/gateway.ts`
- Test: `apps/api/src/modules/catalog/catalog.test.ts`

- [x] 테스트를 먼저 추가해 새 입력의 RPC 인자와 malformed 입력 422를 고정한다.
- [x] API 테스트 파일만 실행해 새 테스트가 실패함을 확인한다.
- [x] 양수 외부 금액, 0 이상 혜택 차감 필드와 현재 검증을 연결한다.
- [x] 해당 API 테스트를 통과시킨다.

### Task 2: SQL 원자 원장

**Files:**
- Create: `migrations/092_wallet_manual_refunds.sql`
- Modify: `scripts/db-tests/wallet-usage.mjs`

- [x] DB 테스트를 먼저 추가해 할인/횟수/복합권에 대해 금액과 횟수를 독립 차감하고 재시도/초과를 확인한다.
- [x] 격리 DB 테스트가 신규 RPC 부재로 실패함을 확인한다.
- [x] 불변 이벤트에 환불 금액과 제거 혜택을 따로 저장하고 역할·조직·버전·정산·원 결제 한도 검증을 원자 RPC에 구현한다.
- [x] DB 테스트를 통과시킨다.

### Task 3: 관리자 화면과 API 타입

**Files:**
- Modify: `apps/desktop-react/src/features/catalog/schemas.ts`
- Modify: `apps/desktop-react/src/features/catalog/api.ts`
- Modify: `apps/desktop-react/src/features/catalog/WalletDialogs.tsx`
- Test: `apps/desktop-react/src/features/catalog/catalog.test.tsx`

- [x] 화면/API 테스트를 먼저 추가해 독립 필드 전달과 확인을 검증한다.
- [x] React 테스트 파일만 실행해 실패를 확인한다.
- [x] 별도 입력란과 외부 환불 완료 확인, 현금·금액·횟수 변동 결과 및 이력을 연결한다.
- [x] 대상 API/React 테스트와 빌드를 통과시킨다.

### Task 4: 제품 문서 갱신

**Files:**
- Create: `docs/product/audits/2026-10-20-wallet-manual-refunds.md`
- Modify: `docs/product/README.md`, `docs/product/changelog.md`, `docs/product/roadmap.md`
- [x] 실제 구현·격리 테스트·Supabase 적용 대기 범위를 기록한다.
- [x] `git diff --check`를 실행한다.
