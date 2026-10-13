# Node/TypeScript API Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Python FastAPI service with a Node.js TypeScript API while preserving Supabase security boundaries and API behavior.

**Architecture:** Add a Fastify service at `apps/api` and a Zod contract package shared with React. Migrate API domains in dependency order, starting with authentication and the React customer vertical slice; keep FastAPI only until every domain has contract and real-environment parity, then remove Python in a final dedicated task.

**Tech Stack:** Node.js 24, TypeScript, Fastify, Zod, `@supabase/supabase-js`, pnpm, Vitest, React 19, Tauri 2.

**Spec:** `docs/superpowers/specs/2026-10-13-node-api-migration-design.md`

## Global Constraints

- Keep `/api/v1` route paths and HTTP status semantics stable while migrating each domain.
- Never expose Supabase service credentials to the React bundle or Tauri configuration.
- Validate request payloads and external Supabase responses at the server boundary with Zod.
- Verify organization membership, role, and feature entitlement for every protected route.
- Do not return placeholder successes for API domains not yet migrated.
- Reimplement LCID patterns as product-owned code; do not copy LCID source files.
- Do not delete FastAPI, uv, or Python until every listed API domain and Windows acceptance check is complete.
- Do not commit or push unless the user asks.

## Review Focus

- A user must not obtain another organization’s customer, photo, appointment, or financial data by changing an organization ID.
- A stale or invalid Supabase access token must consistently produce 401, not an internal server error.
- Replayed write requests must preserve existing idempotency and version-conflict behavior.
- Storage upload/download URLs must reject unsafe file names, bucket paths, and unauthorized customer IDs.
- Marketing campaigns must require an explicit recipient consent and retain an opt-out path.

---

### Task 1: Integrate the React/Tauri workspace baseline

**Files:**
- Integrate: `codex/react-tauri-customer` branch changes for `apps/desktop-react/`, `packages/react-ui/`, root `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`
- Modify: `README.md`, `.gitignore`
- Test: existing `apps/desktop-react/src/**/*.test.tsx`, `packages/react-ui/src/**/*.test.tsx`

**Interfaces:**
- Produces the pnpm workspace consumed by all later Node packages.
- Keeps the current FastAPI API address as the temporary client target.

- [ ] Confirm the current branch has no conflicting uncommitted changes before integrating the React/Tauri baseline.
- [ ] Run `pnpm react:test -- --run` and `pnpm react:build`; record the result without running the Python full suite.
- [ ] Update root setup documentation to require Node 24 and pnpm 11.19.0.

### Task 2: Create shared API contracts and Fastify application foundation

**Files:**
- Create: `packages/api-contract/package.json`, `packages/api-contract/src/index.ts`, `packages/api-contract/src/errors.ts`
- Create: `apps/api/package.json`, `apps/api/tsconfig.json`, `apps/api/src/app.ts`, `apps/api/src/config.ts`, `apps/api/src/server.ts`
- Create: `apps/api/src/app.test.ts`
- Modify: root `package.json`, `pnpm-workspace.yaml`, `.env.example`

**Interfaces:**
- Produces `createApp(config: ApiConfig): FastifyInstance` and `ApiErrorSchema`.
- Produces `GET /api/v1/health` with `{ status: 'ok' }`.

- [ ] Write a failing Fastify injection test for the health endpoint and invalid environment validation.
- [ ] Implement typed environment parsing for the Supabase URL, publishable key, service key, storage bucket, and API port.
- [ ] Implement the Fastify application, structured error conversion, request ID assignment, and graceful shutdown.
- [ ] Run `pnpm --filter @business-assistant/api test` and `pnpm --filter @business-assistant/api build`.

### Task 3: Move authentication, organizations, and entitlement enforcement

**Files:**
- Create: `apps/api/src/supabase/client.ts`, `apps/api/src/plugins/auth.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/routes/organizations.ts`, `apps/api/src/routes/entitlements.ts`
- Create: `packages/api-contract/src/auth.ts`, `packages/api-contract/src/organizations.ts`
- Test: `apps/api/src/routes/auth.test.ts`, `apps/api/src/routes/organizations.test.ts`

**Interfaces:**
- Consumes `createApp` and contract schemas from Task 2.
- Produces the existing login, refresh, current-user, organization list, membership, and entitlement route contracts.
- Produces `requireOrganizationAccess(request, organizationId, requiredFeature?)` for all later protected routes.

- [ ] Write failing tests for no token (401), invalid token (401), missing membership (403), and missing feature (403).
- [ ] Implement Supabase password sign-in and token verification without logging credentials or tokens.
- [ ] Implement organization and entitlement queries with organization-scoped authorization.
- [ ] Run focused route tests and confirm the React login client accepts the preserved response shape.

### Task 4: Move the React customer vertical slice

**Files:**
- Create: `packages/api-contract/src/customers.ts`, `apps/api/src/routes/customers.ts`, `apps/api/src/routes/customer-activities.ts`, `apps/api/src/routes/customer-photos.ts`
- Create: `apps/api/src/services/customer-photos.ts`
- Test: `apps/api/src/routes/customers.test.ts`, `apps/api/src/routes/customer-activities.test.ts`, `apps/api/src/routes/customer-photos.test.ts`
- Modify: `apps/desktop-react/src/api/client.ts`, related React API tests

**Interfaces:**
- Consumes `requireOrganizationAccess` and Supabase server client.
- Produces existing customer, archive, activity, and photo signed URL endpoints at their current paths.

- [ ] Write failing contract tests for cross-organization customer access, malformed photos, upload URL retry, and storage failure responses.
- [ ] Implement customer listing, create, update, archive, activity CRUD, photo listing/deletion, and signed upload/download URLs.
- [ ] Point the React API client at shared schemas and verify login → organization → customer → activity → photo flows through Fastify injection and React tests.
- [ ] Run focused API and React tests plus production builds.

### Task 5: Add LCID-derived customer productivity and CRM marketing

**Files:**
- Create: `packages/api-contract/src/tags.ts`, `packages/api-contract/src/followups.ts`, `packages/api-contract/src/marketing.ts`
- Create: `apps/api/src/routes/tags.ts`, `apps/api/src/routes/followups.ts`, `apps/api/src/routes/marketing.ts`
- Create: `migrations/039_crm_productivity_marketing.sql`
- Modify: `docs/product/menus/02-customers.md`, `docs/product/menus/10-communications-marketing.md`, `docs/product/changelog.md`
- Test: `apps/api/src/routes/tags.test.ts`, `apps/api/src/routes/followups.test.ts`, `apps/api/src/routes/marketing.test.ts`, `scripts/db-tests/marketing.mjs`

**Interfaces:**
- Produces organization-scoped tags, customer follow-up records, marketing consent, campaign draft, delivery log, opt-out, and aggregate outcome contracts.
- Requires `crm.basic` for tags/follow-ups and an explicit marketing entitlement for campaign actions.

- [ ] Write failing migration and route tests for consent absence, opt-out, duplicate campaign delivery, role denial, and cross-organization access.
- [ ] Implement append-only campaign recipient outcomes and idempotent delivery scheduling; do not transmit real messages until an approved provider integration exists.
- [ ] Add React customer tag/follow-up and campaign management screens after their API contracts pass.
- [ ] Run focused database, API, and React tests; document SQL deployment and real-provider limitations.

### Task 6: Move scheduling, treatment, documents, sales, and ERP APIs in domain batches

**Files:**
- Create: domain contract and Fastify route/service pairs under `packages/api-contract/src/` and `apps/api/src/routes/` for appointments, treatments, documents, sale carts, payments, catalog, finance, files, and management.
- Test: equivalent `apps/api/src/routes/*.test.ts` files and focused `scripts/db-tests/*.mjs` scenarios.
- Modify: React feature API clients as each screen is migrated.

**Interfaces:**
- Consumes the authorization primitives from Task 3 and shared contracts from Task 2.
- Produces all former FastAPI `/api/v1` endpoints with unchanged protected behavior.

- [ ] Migrate one cohesive domain batch at a time: appointment resources; treatment/documents; sales/wallets; catalog/inventory; finance/files/management.
- [ ] For every batch, start with route contract and organization-isolation tests, implement the service, then run focused tests before moving on.
- [ ] Add LCID-derived dashboard drill-down, attendance/leave workflow, notices, favorites/recent items, SSE reconnect state, and Tauri update/auto-start support only when their corresponding data contracts exist.
- [ ] Update product feature states and changelog with verified evidence after each completed batch.

### Task 7: Switch launch scripts and remove the Python implementation

**Files:**
- Modify: `scripts/run-server.ps1`, `scripts/bootstrap.ps1`, `scripts/check.ps1`, `README.md`, developer and operator guides
- Delete: `apps/server/`, `packages/common/`, Python-only scripts, `pyproject.toml`, `uv.lock`
- Test: `apps/api/src/**/*.test.ts`, `apps/desktop-react/src/**/*.test.tsx`, Tauri native smoke check

**Interfaces:**
- `scripts/run-server.ps1` starts `apps/api` on port 8000.
- Root checks run Node API and React checks with no Python executable dependency.

- [ ] Add a failing smoke check proving the launch script starts the Node health endpoint without resolving Python or uv.
- [ ] Switch the server script only after Task 6 has API parity; preserve an explicit rollback branch until Windows acceptance is complete.
- [ ] Remove Python code, dependency manifests, lockfile, and obsolete documentation only after parity and all targeted checks pass.
- [ ] Verify on the company PC: Node API launch, React web launch, Tauri native launch, login, CRM write/photo, appointment, treatment, payment, document, file, and organization denial flows.

## Plan self-review

- The plan maps every spec requirement to Tasks 1–7: Node foundation, shared contracts, authorization, current React flow, LCID additions including marketing, remaining API domains, and deferred Python removal.
- Cross-organization access, token failures, idempotent writes, storage safety, and consent/opt-out are covered by dedicated route tests.
- Python removal is deliberately last because deleting it sooner would make existing API domains unavailable.
