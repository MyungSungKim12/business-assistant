# Isolated treatment lifecycle SQL verification

2026-11-03 customer messaging outbox (SQL 109) focused verification:

```powershell
node scripts/db-tests/customer-messaging-109.mjs
```

This runs SQL 109 in an isolated PGlite database and checks tenant/role
boundaries, consent and customer eligibility, idempotent enqueue, cancellation,
retry, audit records, and RPC-only table access. It never sends messages or
connects to Supabase.

2026-10-30 customer photo completion/pending recovery (SQL 100) focused verification:

```powershell
node scripts/db-tests/customer-photo-upload-100.mjs
```

This runs an isolated PostgreSQL engine and checks legacy migration/re-run safety,
actual Storage metadata size/MIME, idempotency, crash recovery, expiry, and role/org
boundaries. It never connects to Supabase or changes real customer data.

From the repository root:

```powershell
npm ci --prefix scripts/db-tests --ignore-scripts --no-audit --no-fund
npm test --prefix scripts/db-tests
```

The pinned PGlite dependency executes actual PostgreSQL SQL in a fresh in-memory
database. No credentials, network database, live customers, or deployment are used.
The runner supplies minimal auth/organization/customer fixtures and the same
membership helper logic as migration 001, then executes the actual migrations 014
and 016. Existing treatment rows are inserted between those migrations to test the
legacy transition. RLS checks run with `SET ROLE authenticated` and simulated
`auth.uid()` identities; mutation checks execute the public RPC.

Coverage includes legacy/default values, all lifecycle actions, audit snapshots,
permissions and tenant isolation, invalid values, optimistic version conflicts,
operation replay/mismatch, injected audit failure rollback, and restrictive audit
foreign keys. PostgreSQL 18 uses SQLSTATE `23001` for the tested RESTRICT deletes.

Limitations: this is not a Supabase/PostgREST deployment, JWT validation, advisor
run, real concurrent multi-connection race test, or full migration-chain test.
The row-lock and transaction mechanism is exercised sequentially; production
Supabase verification remains a separate required step before deployment.

Migration 016 follows this repository's existing numbered 001–015 convention.
The Supabase CLI/local stack is unavailable in the current environment, so the
skill's CLI-generated filename/advisor workflow was replaced by an isolated SQL
execution test. No migration history or live database was modified.

## Treatment consumables (046)

Run `npm run test:treatment-consumables --prefix scripts/db-tests` to execute
migrations 014, 016, 017, and 046 against a fresh in-memory PostgreSQL database. It
checks recipe validation, organization and role boundaries, insufficient-stock
rollback, treatment completion and stock-ledger atomicity, idempotent retry, and
preservation of historical `consult` events, plus no retroactive deduction for
unlinked treatments. It does not connect to Supabase or simulate concurrent
database sessions.
# Consultation migration 017

`npm test` runs the original migration-016 lifecycle suite and then the separate
consultation suite. `npm run test:consultation` runs only the latter. Both create
fresh in-memory PostgreSQL instances; neither connects to a live database.

The consultation suite covers draft saving, current-profile acknowledgment,
start guards, idempotent replay after profile changes, version conflicts,
input/metadata rejection, role and organization checks, private-helper access,
audit rollback, length boundaries, and unchanged historical records.
PGlite does not establish real Supabase/PostgREST behavior or multi-connection
concurrency guarantees; deployment and concurrent profile-update checks remain
separate environment validation tasks.
## Document template versions (018)

`npm test` also runs `document-versions.mjs`; `npm run test:documents` runs it alone.
It applies real migrations 007 and 018 to an in-memory database with auth/organization fixtures.
Ten check groups cover conservative legacy migration, create/retry deduplication, publication
snapshots, revision conflicts, revision creation, retirement, malformed fields, member/anonymous
denial, direct-write denial, cross-tenant RLS and immutable historical content.
No real deployment, full migration chain, PostgREST or concurrent multi-connection test is implied.
## Treatment document issuance (019)

`npm test` includes `document-issuance.mjs`; `npm run test:issuance` runs it alone.
It executes migrations 007/014/016/017/018/019 with minimal auth/organization/customer fixtures.
Thirteen groups check plain-text single-pass rendering, zero/missing values, malformed/unknown
tokens, length limits, stale previews, immutable issuance and idempotent retries, role/tenant
isolation, direct-write denial, retirement and source-delete restrictions. Some source mutations
in the test use the database owner intentionally to simulate later changes; client access uses
authenticated/anon roles. The full suite has 50 groups. Real concurrency/PostgREST remain pending.
## Consent ledger (020)

`npm test` includes `document-consent.mjs` (13 groups; full suite 63).
It verifies normalized strokes and limits, exact field validation, required confirmations,
manager/admin and tenant boundaries, SHA256 binding, optimistic revisions, exact replay,
repeat delivery, terminal withdrawal, immutable events and restrictive references.
Python/Qt and real PostgREST/multi-session verification remain separate pending checks.

## Ops memo, labels, consent (047)

Run `npm run test:ops-047 --prefix scripts/db-tests` to execute migrations 006, 024, 034, and 047
(twice, to prove idempotency) against a fresh in-memory PostgreSQL database. It checks the task
label/checklist limits, that the database stamps the marketing-consent time only when the value
changes (a client-supplied timestamp is ignored), and the appointment memo RPC: member/owner access,
outsider and cross-organization rejection, length limits, no version bump, and no direct table update.

## Task recurrence and customer link (048)

Run `npm run test:ops-048 --prefix scripts/db-tests` to execute migrations 006, 024, 034, 047, and 048
(048 twice) against a fresh in-memory PostgreSQL database. It checks daily/weekly/monthly successor
creation (KST wall clock, month-end clamp), skipping past due dates, copying fields while resetting the
checklist, no successor for non-recurring/no-due/non-done transitions, at most one successor per task,
a manager completing a member's task, cross-organization customer rejection, and that deleting a
customer only clears the link.

## Task assignee and completion record (049)

Run `npm run test:ops-049 --prefix scripts/db-tests` to execute migrations 006, 024, 034, 047, 048, and 049
(049 twice). It checks that an assignee must be an organization member, that an assignee-only member may
change just status and checklist (title, description, and reassignment are rejected with 42501), that
another member cannot touch the task, that the database stamps the real caller as completer with a
name snapshot (forged values ignored, cleared on reopen), the email-prefix fallback name, that the name
list exposes no email, that the completer record survives membership removal, and that recurring
successors keep the assignee unless the assignee has left.

## Service staff eligibility (050)

Run `npm run test:ops-050 --prefix scripts/db-tests` to execute migrations 024, 034, 037, 038, and 050
(050 twice) against a fresh in-memory PostgreSQL database and drive the real `save_appointment` RPC.
It checks that services without a mapping stay open to everyone, that a mapping restricts new bookings and
staff/service changes (22023) but not time-only edits or status transitions of existing bookings, replace
semantics and the empty-array reset, duplicate/unknown-staff/unknown-service validation, manager-only
writes, member read access, and cross-organization isolation.

## Treatment protocol templates (051)

Run `npm run test:ops-051 --prefix scripts/db-tests` to execute migration 051 (twice) against a fresh
in-memory PostgreSQL database. It checks owner/admin create-update-delete versus member read-only access,
the `created_by` default, case/whitespace-insensitive unique names, every length limit, the version bump and
timestamp trigger, optimistic locking via a `version` predicate (stale updates match no row), immutable
organization/creator, and cross-organization isolation.

## Recurring expenses (052)

Run `npm run test:ops-052 --prefix scripts/db-tests` to execute migrations 008, 042, and 052 (052 twice)
against a fresh in-memory PostgreSQL database, including the real month-close trigger. It checks
owner/admin versus member access, input limits, unique names, the day-of-month clamp (31 becomes the last
day), that registering the same month again creates nothing new while a newly added item is still
registered, that inactive items are skipped, that edits and deletes never change registered transactions,
the version/optimistic lock, the closed-month rejection and re-registration after reopening, the
too-far-future guard, and cross-organization isolation.

## Customer photo trash (053)

Run `npm run test:ops-053 --prefix scripts/db-tests` to execute the table/policy part of migration 022 and
migration 053 (twice) against a fresh in-memory PostgreSQL database. It checks that archiving stamps the
caller, time, name snapshot, and reason in the database (forged values ignored, record frozen while archived,
cleared on restore), the email-prefix fallback name, that failed-upload cleanup stays out of the trash, the
reason constraint, owner/admin versus member write access, cross-organization isolation, and that the
archiver name survives membership removal.

## Document template fields (054)

Run `npm run test:ops-054 --prefix scripts/db-tests` to execute migrations 007, 014, 016-019 and then 054
(twice) against a fresh in-memory PostgreSQL database. It checks that the new fields are unknown before 054,
that the original fields render unchanged afterwards, that organization name, KST date, skin type, allergies,
treatment category, next visit date, and consultation plan fill in and land in the source snapshot, that an
issued document keeps its values after the customer record changes, that blank values block issuance,
that members can preview but not issue or call the renderer directly, and that malformed tokens still fail closed.

## Customer merge (065)

Run `npm run test:customer-merge-065 --prefix scripts/db-tests` to execute the real `merge_customers` function from migration 065 (twice applied) against a fresh in-memory PostgreSQL database with minimal stand-in tables. It checks that every table carrying `customer_id` (including the appointment waitlist) moves to the primary customer with matching counts, that other customers and other organizations stay untouched, that the secondary customer is archived rather than deleted, field merging, same-request retry versus conflicting operation id, rejection of already merged customers and customers with immutable sale handoff records, and member/anonymous permission denial. It fails when a new migration adds a `customer_id` table that the merge and this test do not know about.

## 104 영속 전화 수신함 집중 검증

`node scripts/db-tests/phone-inbox-104.mjs`를 저장소 루트에서 실행한다. SQL104를 새 PGlite DB에 두 번 적용해 동의/수신자·배정/조직·권한/멱등·충돌/기한·정리/원장 보존을 확인한다. API를 먼저 `pnpm --filter @business-assistant/api build`한 다음 `node scripts/db-tests/phone-inbox-104.mjs --api`로 실행하면 두 독립 real gateway/App 객체의 공유 SQL 전달, 동시 재시도와 서버 객체 재생성 복구도 확인한다. 원격 DB/실제 앱/OS 다중 프로세스 시험은 아니다.

## 110 복수 시술 방문 그룹

`node scripts/db-tests/appointment-visit-groups-110.mjs`를 저장소 루트에서 실행한다. SQL110을 격리 PGlite DB에 적용해 그룹 생성·멱등·권한/조직/지점 범위·직원 자격·충돌 시 전체 롤백·단일 구간 편집 차단·그룹 교체/취소·체크인 시 방문 및 카트 1건·완료/노쇼 버전 동기화와 RLS/ACL을 검사한다. 원격 사용자 세션과 Tauri 업무 인수는 포함하지 않는다.

## 111/112 고객 모바일 동의서 서명

`node scripts/db-tests/customer-document-signatures-111.mjs`를 실행한다. SQL111/112를 격리 PGlite에 적용해 토큰 해시만 저장, 최소 공개 미리보기, owner/admin 제어, 링크 철회/교체 행위자 기록, 만료/일회 사용, 동일 요청 재시도, 문서 버전 고정, 불변 서명 증빙 hash 일치와 직접 테이블 접근 차단을 검사한다. Supabase 원격 적용·실제 HTTPS 모바일 링크·고객 인수는 포함하지 않는다.
