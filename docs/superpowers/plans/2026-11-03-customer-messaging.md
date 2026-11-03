# N1030-08 MKT 메시지 Outbox 구현 계획

> **For agentic workers:** Use `superpowers:executing-plans` to execute each step with focused checks. No commit unless user asks.

**Goal:** 동의와 조직 권한을 다시 확인하는 메시지 템플릿·대상 미리보기·멱등 outbox와 취소/재시도 기반을 만든다.
**Architecture:** React/Tauri 화면에서 Node API를 호출하고, API는 기존 사용자 JWT로 조직 범위 PostgREST RPC를 호출한다. DB 테이블은 RPC-only이며 실제 공급자 전송은 미설정 상태에서 실패로 단정하지 않고 대기 상태를 보여준다.
**Tech Stack:** TypeScript/Fastify, React 19, Supabase PostgreSQL, PGlite.
**Spec:** `docs/superpowers/specs/2026-11-03-customer-messaging-design.md` 및 상위 N1030-08 명세.

## Global Constraints

- 고객 메시지 실제 발송/외부 자격 증명 없이 성공 상태 금지.
- 고객의 최신 동의·상태·연락처를 DB에서 검사하고 타 조직/비회원 거부.
- phone/body/token은 로그·감사 metadata에 기록하지 않는다.
- outbox는 고객 ID와 버전 정보를 최소 보관하고 200명, 4,000자, retry<=3 제한.

## Review Focus

- enqueue 직전 동의 철회/고객 보관/연락처 삭제는 포함 대상에서 빠져야 한다 (SQL integration).
- 같은 operation ID 재시도는 두 번째 row를 만들지 않아야 한다 (SQL integration).
- 조직 밖 customer/template ID, member의 무권한 변경은 거절해야 한다 (SQL/API).
- 취소/재시도 경합에서 delivered/cancelled 상태를 뒤집으면 안 된다 (SQL).
- 공급자 미설정은 UI/API에서 대기 상태로 나타나고 성공으로 둔갑하지 않아야 한다 (API/UI).

## Files

- Create `migrations/109_customer_messaging_outbox.sql` — templates, outbox, RLS, scoped RPCs.
- Create `scripts/db-tests/customer-messaging-109.mjs` — PGlite migration behavior tests.
- Create `apps/api/src/modules/marketing/{gateway.ts,routes.ts,index.ts,marketing.test.ts}` — response validation, endpoints, permissions and fail-closed transport config.
- Modify `apps/api/src/config.ts`, `apps/api/src/app.ts` — provider readiness and module registration.
- Create `apps/desktop-react/src/features/marketing/{MarketingPage.tsx,api.ts,types.ts,marketing.css,MarketingPage.test.tsx}`.
- Modify `apps/desktop-react/src/features/shell/TopBar.tsx`, `menuCatalog.ts`, `app/Workspace.tsx` — accessible “고객 소통” menu/page.
- Update MKT product page, product completion status, changelog, migrations README and audit record.

## Tasks

1. Write failing API and isolated SQL tests for permission, audience filtering, organization boundaries, idempotency, cancellation, retry ceiling, and no provider success.
2. Implement SQL109 RPC contract and make PGlite tests pass; review all ACL/role checks before remote apply.
3. Implement API routes and focused API tests; only expose `provider_ready=false` until a supported provider is wired.
4. Implement a compact screen for templates, audience preview, schedule/outbox status, cancel/retry and error/empty/loading states.
5. Run focused tests and API/React builds; apply SQL109 only after isolated verification and remote migration preflight.
6. Record exact verified scope and provider/live-send exclusions, then move to N1030-09.
