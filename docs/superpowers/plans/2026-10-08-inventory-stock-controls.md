# Inventory Stock Controls Implementation Plan

**Goal:** Add auditable partial stock returns, disposal, and count adjustment to the existing product inventory flow.

**Architecture:** Keep `catalog_products.stock_quantity` as the locked balance and append every adjustment to the immutable `catalog_stock_ledger`. A single organization-scoped Postgres RPC checks manager role, expected product version, operation idempotency, valid quantities, and nonnegative balance. Expose it through the existing catalog API and recovery-aware product dialog.

**Tech Stack:** PostgreSQL/Supabase migration, FastAPI/Pydantic, httpx repository, PySide6, pytest, PGlite.

**Spec:** `docs/product/menus/07-products-inventory-purchase.md` (INV-002).

## Global Constraints

- Preserve all existing working-tree changes and do not commit, push, or touch production data.
- Direct table writes remain blocked; organization and manager authorization are enforced in the RPC and API.
- Ledger events are immutable and each retry reuses the same operation ID and request fingerprint.
- Stocktake receives the observed count and applies only the difference while holding the product row lock; stale versions fail safely.

## Review Focus

- Removing more stock than available is rejected without changing balance or ledger.
- Replaying the same operation returns the original result; reusing its ID for different input fails.
- A stale stocktake cannot overwrite a receipt or sale that happened after the count began.
- Members, outsiders, memberships, and other organizations cannot mutate stock.
- Lost responses preserve the same recovery request across dialog restart.

## Tasks

1. [x] Add API, repository, dialog, and isolated SQL tests for supplier return, disposal, and stocktake.
2. [x] Add an idempotent migration with RPC-only ledger changes, strict scope/role/version checks, immutable event history, and SQL integration cases.
3. [x] Wire the RPC through the server model/repository/API and validate request/response boundaries.
4. [x] Add movement selection, history view, and protected retry flow to the existing catalog manager.
5. [x] Run focused and full server/desktop/database tests, lint/format/type checks, and record evidence and remaining limits in the product docs.

## Verification Evidence

- `uv run --all-packages pytest apps/server/tests packages -q --tb=short` — 440 passed.
- `uv run --package business-assistant-desktop pytest apps/desktop/tests -q --tb=short` — 230 passed.
- `npm test` in `scripts/db-tests` — all isolated database suites passed; catalog/sales includes 9 groups.
- `uv run ruff check .` and changed-file `ruff format --check` — passed.
- Focused mypy on the four changed Python source files — passed.
- `uv run --with-requirements requirements-docs.txt mkdocs build --strict` — passed.
