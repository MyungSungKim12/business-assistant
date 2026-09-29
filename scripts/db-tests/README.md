# Isolated treatment lifecycle SQL verification

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
