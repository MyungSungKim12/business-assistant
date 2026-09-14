# Business Assistant Project Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a reproducible Python 3.13 monorepo with a runnable PySide6 desktop shell, a runnable FastAPI server, Supabase-ready provider boundaries, subscription(구독) entitlement contracts, automated checks, and beginner-friendly documentation.

**Architecture:** The repository is a uv workspace with separate desktop, server, and common packages. The desktop communicates only with FastAPI; the server owns authentication and authorization and reaches Supabase through replaceable ports. External Supabase credentials are optional for the bootstrap, so all local tests run without a cloud account.

**Tech Stack:** Python 3.13, uv, PySide6, FastAPI, Uvicorn, Pydantic Settings, SQLAlchemy 2.x, Alembic, pytest, pytest-qt, HTTPX, Ruff, mypy

**Spec:** `docs/superpowers/specs/2026-09-14-business-assistant-design.md`

## Global Constraints

- Use Python `>=3.13,<3.14`; do not depend on the machine-wide Python 3.14 runtime.
- Use a uv workspace and commit `uv.lock`.
- The desktop must never contain a Supabase service key or a PostgreSQL connection string.
- The desktop communicates with business data only through FastAPI over HTTPS in deployed environments.
- Supabase Auth, PostgreSQL, and Storage access must sit behind replaceable server-side interfaces.
- The bootstrap must run and test without Supabase credentials.
- Use lowercase `snake_case` for Python modules and future PostgreSQL identifiers.
- Never commit `.env`, tokens, database passwords, private keys, or generated local data.
- Each task must finish with its stated focused test and commit before the next task begins.

---

## Planned File Map

```text
business-assistant/
├─ apps/
│  ├─ desktop/
│  │  ├─ pyproject.toml
│  │  ├─ src/business_assistant_desktop/
│  │  │  ├─ __init__.py
│  │  │  ├─ __main__.py
│  │  │  ├─ app.py
│  │  │  ├─ main_window.py
│  │  │  └─ menu_catalog.py
│  │  └─ tests/
│  │     ├─ test_main_window.py
│  │     └─ test_menu_catalog.py
│  └─ server/
│     ├─ pyproject.toml
│     ├─ src/business_assistant_server/
│     │  ├─ __init__.py
│     │  ├─ __main__.py
│     │  ├─ config.py
│     │  ├─ main.py
│     │  ├─ api/health.py
│     │  └─ ports/
│     │     ├─ auth.py
│     │     └─ storage.py
│     └─ tests/
│        ├─ test_config.py
│        ├─ test_health.py
│        └─ test_ports.py
├─ packages/common/
│  ├─ pyproject.toml
│  ├─ src/business_assistant_common/
│  │  ├─ __init__.py
│  │  ├─ entitlements.py
│  │  └─ models.py
│  └─ tests/
│     ├─ test_entitlements.py
│     └─ test_models.py
├─ docs/
│  ├─ 01-product-overview.md
│  ├─ 02-architecture.md
│  ├─ 03-menu-modules.md
│  ├─ 04-subscription-design.md
│  ├─ 05-development-guide.md
│  ├─ 06-implementation-roadmap.md
│  ├─ 07-git-guide.md
│  └─ superpowers/
├─ scripts/
│  ├─ bootstrap.ps1
│  ├─ check.ps1
│  ├─ run-desktop.ps1
│  └─ run-server.ps1
├─ .editorconfig
├─ .env.example
├─ .gitattributes
├─ .gitignore
├─ .python-version
├─ pyproject.toml
└─ uv.lock
```

---

### Task 1: Reproducible uv Workspace and Common Contracts

**Files:**
- Create: `.python-version`
- Create: `.gitignore`
- Create: `.gitattributes`
- Create: `.editorconfig`
- Create: `pyproject.toml`
- Create: `packages/common/pyproject.toml`
- Create: `packages/common/src/business_assistant_common/__init__.py`
- Create: `packages/common/src/business_assistant_common/models.py`
- Create: `packages/common/src/business_assistant_common/entitlements.py`
- Test: `packages/common/tests/test_models.py`
- Test: `packages/common/tests/test_entitlements.py`

**Interfaces:**
- Consumes: Python 3.13 installed and selected by uv.
- Produces: `HealthStatus`, `FeatureCode`, `EntitlementSet.has(feature_code)`, and an installable `business-assistant-common` workspace package.

- [ ] **Step 1: Install uv and uv-managed Python 3.13**

Run:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
$env:Path = "$env:USERPROFILE\.local\bin;$env:Path"
uv python install 3.13
uv --version
uv python list
```

Expected: `uv --version` exits 0 and the list contains an installed CPython 3.13 runtime.

- [ ] **Step 2: Write the workspace configuration and ignore rules**

Use this root project configuration:

```toml
[project]
name = "business-assistant-workspace"
version = "0.1.0"
requires-python = ">=3.13,<3.14"
dependencies = []

[dependency-groups]
dev = [
  "httpx>=0.28,<1",
  "mypy>=1.15,<2",
  "pytest>=8.3,<9",
  "pytest-qt>=4.4,<5",
  "ruff>=0.11,<1",
]

[tool.uv]
package = false

[tool.uv.workspace]
members = ["apps/desktop", "apps/server", "packages/common"]

[tool.pytest.ini_options]
addopts = "-ra"
testpaths = ["apps", "packages"]

[tool.ruff]
line-length = 100
target-version = "py313"

[tool.ruff.lint]
select = ["E", "F", "I", "UP", "B", "SIM"]

[tool.mypy]
python_version = "3.13"
strict = true
```

Set `.python-version` to `3.13`. Ignore `.env`, `.venv`, `__pycache__`, pytest/mypy/Ruff caches, coverage output, build artifacts, IDE metadata, logs, and local SQLite files. Use UTF-8, LF in Git, four spaces for Python, and CRLF only for `.ps1` working copies.

- [ ] **Step 3: Write failing common-model tests**

```python
from business_assistant_common.entitlements import EntitlementSet
from business_assistant_common.models import HealthStatus


def test_health_status_serializes_service_state() -> None:
    status = HealthStatus(service="business-assistant-server", status="ok")
    assert status.model_dump() == {
        "service": "business-assistant-server",
        "status": "ok",
    }


def test_entitlement_set_checks_exact_feature_code() -> None:
    entitlements = EntitlementSet(frozenset({"dashboard.basic", "crm.basic"}))
    assert entitlements.has("crm.basic") is True
    assert entitlements.has("crm.export") is False
```

- [ ] **Step 4: Run the tests to verify the red state**

Run: `uv run pytest packages/common/tests -v`

Expected: FAIL because `business_assistant_common` and its public types do not exist.

- [ ] **Step 5: Implement the common package minimally**

`models.py`:

```python
from typing import Literal

from pydantic import BaseModel, ConfigDict


class HealthStatus(BaseModel):
    model_config = ConfigDict(frozen=True)

    service: str
    status: Literal["ok"]
```

`entitlements.py`:

```python
from dataclasses import dataclass
from typing import NewType

FeatureCode = NewType("FeatureCode", str)


@dataclass(frozen=True, slots=True)
class EntitlementSet:
    features: frozenset[str]

    def has(self, feature_code: str) -> bool:
        return feature_code in self.features
```

Export `EntitlementSet`, `FeatureCode`, and `HealthStatus` from the package `__init__.py`. Configure the common member package with a `src` build and a dependency on `pydantic>=2.11,<3`.

- [ ] **Step 6: Sync and verify the common package**

Run:

```powershell
uv sync --all-packages
uv run pytest packages/common/tests -v
uv run ruff check packages/common
uv run mypy packages/common/src
```

Expected: all commands exit 0; pytest reports 2 passed.

- [ ] **Step 7: Commit the workspace foundation**

```powershell
git add .python-version .gitignore .gitattributes .editorconfig pyproject.toml uv.lock packages/common
git commit -m "build: initialize Python workspace"
```

---

### Task 2: FastAPI Server Shell and Supabase Provider Ports

**Files:**
- Create: `apps/server/pyproject.toml`
- Create: `apps/server/src/business_assistant_server/__init__.py`
- Create: `apps/server/src/business_assistant_server/__main__.py`
- Create: `apps/server/src/business_assistant_server/config.py`
- Create: `apps/server/src/business_assistant_server/main.py`
- Create: `apps/server/src/business_assistant_server/api/__init__.py`
- Create: `apps/server/src/business_assistant_server/api/health.py`
- Create: `apps/server/src/business_assistant_server/ports/__init__.py`
- Create: `apps/server/src/business_assistant_server/ports/auth.py`
- Create: `apps/server/src/business_assistant_server/ports/storage.py`
- Test: `apps/server/tests/test_config.py`
- Test: `apps/server/tests/test_health.py`
- Test: `apps/server/tests/test_ports.py`

**Interfaces:**
- Consumes: `business_assistant_common.models.HealthStatus` from Task 1.
- Produces: `Settings`, `AuthPort`, `StoragePort`, `create_app() -> FastAPI`, `GET /api/v1/health`, and `python -m business_assistant_server`.

- [ ] **Step 1: Write failing settings and health tests**

```python
from fastapi.testclient import TestClient

from business_assistant_server.config import Settings
from business_assistant_server.main import create_app


def test_settings_have_safe_local_defaults() -> None:
    settings = Settings(_env_file=None)
    assert settings.environment == "development"
    assert settings.supabase_url is None
    assert settings.supabase_service_key is None


def test_health_endpoint_is_available_without_supabase() -> None:
    client = TestClient(create_app())
    response = client.get("/api/v1/health")
    assert response.status_code == 200
    assert response.json() == {
        "service": "business-assistant-server",
        "status": "ok",
    }
```

- [ ] **Step 2: Write failing port-shape tests**

```python
import inspect

from business_assistant_server.ports.auth import AuthPort
from business_assistant_server.ports.storage import StoragePort


def test_auth_port_exposes_token_verification() -> None:
    assert "verify_access_token" in AuthPort.__dict__
    assert inspect.iscoroutinefunction(AuthPort.verify_access_token)


def test_storage_port_exposes_upload_url_creation() -> None:
    assert "create_upload_url" in StoragePort.__dict__
    assert inspect.iscoroutinefunction(StoragePort.create_upload_url)
```

- [ ] **Step 3: Run focused tests to verify the red state**

Run: `uv run pytest apps/server/tests -v`

Expected: FAIL because the server package is absent.

- [ ] **Step 4: Implement settings, ports, app factory, and health route**

Define settings with optional `AnyHttpUrl` Supabase URL, optional service key, `development` environment default, and `.env` loading. Define runtime-checkable protocols:

```python
from typing import Protocol


class AuthPort(Protocol):
    async def verify_access_token(self, access_token: str) -> str:
        """Return the authenticated Supabase user UUID as text."""
        ...


class StoragePort(Protocol):
    async def create_upload_url(self, bucket: str, object_path: str) -> str:
        """Return a short-lived URL that uploads one object."""
        ...
```

Create a FastAPI app titled `Business Assistant API`, version `0.1.0`, and include a router at `/api/v1`. The health handler returns `HealthStatus(service="business-assistant-server", status="ok")`. The module entry point runs Uvicorn on `127.0.0.1:8000` without reload.

The server package depends on FastAPI, Uvicorn standard extras, Pydantic Settings, SQLAlchemy async support, Alembic, and the workspace common package. No concrete Supabase client is implemented in this task.

- [ ] **Step 5: Sync and verify the server**

Run:

```powershell
uv sync --all-packages
uv run pytest apps/server/tests -v
uv run ruff check apps/server
uv run mypy apps/server/src
uv run python -c "from business_assistant_server.main import create_app; assert create_app().title == 'Business Assistant API'"
```

Expected: all commands exit 0; pytest reports 4 passed.

- [ ] **Step 6: Commit the server shell**

```powershell
git add apps/server pyproject.toml uv.lock
git commit -m "feat: add FastAPI server shell"
```

---

### Task 3: PySide6 Desktop Shell and Feature-Gated Menu Catalog

**Files:**
- Create: `apps/desktop/pyproject.toml`
- Create: `apps/desktop/src/business_assistant_desktop/__init__.py`
- Create: `apps/desktop/src/business_assistant_desktop/__main__.py`
- Create: `apps/desktop/src/business_assistant_desktop/app.py`
- Create: `apps/desktop/src/business_assistant_desktop/main_window.py`
- Create: `apps/desktop/src/business_assistant_desktop/menu_catalog.py`
- Test: `apps/desktop/tests/test_menu_catalog.py`
- Test: `apps/desktop/tests/test_main_window.py`

**Interfaces:**
- Consumes: `EntitlementSet.has(feature_code)` from Task 1.
- Produces: immutable `MenuDefinition`, `visible_menus(entitlements)`, `MainWindow`, `create_application(argv)`, and `python -m business_assistant_desktop`.

- [ ] **Step 1: Write the failing menu-catalog test**

```python
from business_assistant_common.entitlements import EntitlementSet
from business_assistant_desktop.menu_catalog import visible_menus


def test_visible_menus_include_free_and_entitled_features() -> None:
    entitlements = EntitlementSet(frozenset({"crm.basic"}))
    menu_keys = [menu.key for menu in visible_menus(entitlements)]
    assert menu_keys == ["dashboard", "crm", "account", "settings"]
```

- [ ] **Step 2: Write the failing window test**

```python
from business_assistant_common.entitlements import EntitlementSet
from business_assistant_desktop.main_window import MainWindow


def test_main_window_has_product_title(qtbot) -> None:  # type: ignore[no-untyped-def]
    window = MainWindow(EntitlementSet(frozenset()))
    qtbot.addWidget(window)
    assert window.windowTitle() == "Business Assistant"
```

- [ ] **Step 3: Run desktop tests in Qt offscreen mode to verify red state**

Run:

```powershell
$env:QT_QPA_PLATFORM = "offscreen"
uv run pytest apps/desktop/tests -v
```

Expected: FAIL because the desktop package is absent.

- [ ] **Step 4: Implement the menu catalog and minimal window**

Use an immutable menu definition:

```python
from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class MenuDefinition:
    key: str
    label: str
    feature_code: str | None
```

Create the full ordered catalog from the approved 15 menu groups. Give `dashboard`, `account`, and `settings` a `None` feature code so they are always visible; map CRM to `crm.basic` and every other protected menu to the corresponding namespace. `visible_menus` returns always-visible entries plus entries allowed by `EntitlementSet`.

`MainWindow` uses a left `QListWidget` for the visible menu labels and a central welcome panel. It sets title `Business Assistant`, minimum size `1000x700`, and does not make any network request. `create_application` reuses an existing `QApplication` or creates one, applies product metadata, and returns it. The module entry point creates the window and enters the Qt event loop.

- [ ] **Step 5: Sync and verify the desktop**

Run:

```powershell
uv sync --all-packages
$env:QT_QPA_PLATFORM = "offscreen"
uv run pytest apps/desktop/tests -v
uv run ruff check apps/desktop
uv run mypy apps/desktop/src
uv run python -c "from business_assistant_desktop.menu_catalog import MENU_CATALOG; assert len(MENU_CATALOG) == 15"
```

Expected: all commands exit 0; pytest reports 2 passed and the catalog contains 15 menu groups.

- [ ] **Step 6: Commit the desktop shell**

```powershell
git add apps/desktop pyproject.toml uv.lock
git commit -m "feat: add feature-gated desktop shell"
```

---

### Task 4: Environment Template, PowerShell Commands, and Beginner Documentation

**Files:**
- Create: `.env.example`
- Create: `scripts/bootstrap.ps1`
- Create: `scripts/check.ps1`
- Create: `scripts/run-desktop.ps1`
- Create: `scripts/run-server.ps1`
- Create: `docs/01-product-overview.md`
- Create: `docs/02-architecture.md`
- Create: `docs/03-menu-modules.md`
- Create: `docs/04-subscription-design.md`
- Create: `docs/05-development-guide.md`
- Create: `docs/06-implementation-roadmap.md`
- Create: `docs/07-git-guide.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: runnable server and desktop packages from Tasks 2 and 3.
- Produces: one-command bootstrap, check, server, and desktop workflows plus complete onboarding documents.

- [ ] **Step 1: Write safe example configuration**

Create `.env.example` with non-secret values and blank credential fields:

```dotenv
APP_ENVIRONMENT=development
APP_API_BASE_URL=http://127.0.0.1:8000
APP_SUPABASE_URL=
APP_SUPABASE_PUBLISHABLE_KEY=
APP_SUPABASE_SERVICE_KEY=
APP_DATABASE_URL=
```

Add comments explaining that publishable configuration may be supplied to public clients only if a future flow requires it, while the service key and database URL are server-only. Confirm `.env` remains ignored.

- [ ] **Step 2: Create executable PowerShell workflows**

`bootstrap.ps1` checks for uv, installs Python 3.13 through uv, and runs `uv sync --all-packages`.

`check.ps1` executes these commands and stops on the first non-zero exit code:

```powershell
uv run ruff check .
uv run ruff format --check .
uv run mypy apps/server/src apps/desktop/src packages/common/src
$env:QT_QPA_PLATFORM = "offscreen"
uv run pytest
```

`run-server.ps1` runs:

```powershell
uv run python -m business_assistant_server
```

`run-desktop.ps1` runs:

```powershell
uv run python -m business_assistant_desktop
```

Each script resolves the repository root from `$PSScriptRoot`, changes only its own process location, uses `$ErrorActionPreference = "Stop"`, and never prints secret values.

- [ ] **Step 3: Write the seven project documents**

Document the following concrete content:

- `01-product-overview.md`: target users, common modules, initial scope, exclusions, five-stage roadmap.
- `02-architecture.md`: trust boundary, component responsibilities, request flows, provider ports, PostgreSQL RLS tenant isolation, connection pooling, error codes, and logging rules.
- `03-menu-modules.md`: all 15 menu groups, feature-code mapping, initial availability, future industry namespace examples.
- `04-subscription-design.md`: plans/features/subscriptions/entitlements, expiration behavior, device limits, manual bootstrap grants, signed idempotent payment webhooks.
- `05-development-guide.md`: prerequisites, bootstrap command, test/check commands, starting both apps, environment variables, troubleshooting missing uv and Qt offscreen tests.
- `06-implementation-roadmap.md`: acceptance criteria and deliverables for the five approved implementation stages.
- `07-git-guide.md`: branch naming, status/diff/add/commit/pull/push commands, secret checks, and how to add or replace `origin`.

Update README status to `초기 골격 구현 완료` after the Task 4 checks pass. Add exact quick-start commands and links to all seven documents. Task 5 then independently verifies that claim from a fresh shell.

- [ ] **Step 4: Verify scripts and document links**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
powershell -ExecutionPolicy Bypass -File scripts/check.ps1
uv run python -c "from pathlib import Path; text=Path('README.md').read_text(encoding='utf-8'); assert all(f'docs/0{i}-' in text for i in range(1, 8))"
git diff --check
```

Expected: every command exits 0; README links all seven numbered documents; Git reports no whitespace errors.

- [ ] **Step 5: Commit documentation and workflows**

```powershell
git add .env.example scripts docs README.md
git commit -m "docs: add development workflows and guides"
```

---

### Task 5: Fresh Verification, Smoke Tests, and Remote Synchronization

**Files:**
- Modify only files required to correct failures found by the checks; do not expand scope.
- Verify: complete repository and Git state.

**Interfaces:**
- Consumes: all artifacts from Tasks 1–4.
- Produces: a clean, reproducible bootstrap at `main` synchronized with `origin/main`.

- [ ] **Step 1: Run the complete quality gate from a clean shell**

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check.ps1
```

Expected: Ruff check and format check pass, mypy reports no issues, and pytest reports all tests passed.

- [ ] **Step 2: Smoke-test the FastAPI process**

Start `uv run python -m business_assistant_server` in a background process, wait until TCP port 8000 accepts connections with a bounded retry loop, request `http://127.0.0.1:8000/api/v1/health`, and stop the exact process started by the test.

Expected response:

```json
{"service":"business-assistant-server","status":"ok"}
```

- [ ] **Step 3: Smoke-test desktop construction without opening a visible window**

Run:

```powershell
$env:QT_QPA_PLATFORM = "offscreen"
uv run python -c "from business_assistant_common.entitlements import EntitlementSet; from business_assistant_desktop.app import create_application; from business_assistant_desktop.main_window import MainWindow; app=create_application([]); window=MainWindow(EntitlementSet(frozenset())); assert window.windowTitle() == 'Business Assistant'; window.close()"
```

Expected: exit code 0 without a visible window or Qt platform error.

- [ ] **Step 4: Verify secret hygiene and repository contents**

```powershell
git status --short
git ls-files
git grep -n -E "service_role|SUPABASE_SERVICE_KEY=.+|postgres(ql)?://[^[:space:]]+:[^[:space:]@]+@" -- . ':!docs/superpowers/plans/*'
```

Expected: the working tree is clean before any verification correction; tracked file listing contains no `.env`, virtual environment, cache, local DB, or secret; secret grep returns no credential value.

- [ ] **Step 5: Commit a verification-only correction if one was required**

```powershell
$changes = git status --porcelain
if ($changes) {
    git add -u
    git commit -m "fix: correct bootstrap verification failure"
}
```

If no correction was required, skip the commit and confirm `git status --short` has no output. Never create an empty commit.

- [ ] **Step 6: Push and verify the exact remote commit**

```powershell
git push origin main
$localHead = git rev-parse HEAD
$remoteHead = git ls-remote origin refs/heads/main | ForEach-Object { ($_ -split "`t")[0] }
if ($localHead -ne $remoteHead) { throw "origin/main does not match local HEAD" }
git status --short --branch
```

Expected: push exits 0, local and remote commit hashes match, and the branch is clean and tracking `origin/main`.
