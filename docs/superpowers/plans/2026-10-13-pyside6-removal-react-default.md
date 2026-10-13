# PySide6 Removal and React Default Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the PySide6 desktop client and make React/Tauri the only desktop client path.

**Architecture:** Keep FastAPI, common packages, Supabase schema, product documents, and React/Tauri client. Delete the PySide6 application package and its dedicated startup path, then rewrite repository entry points and quality checks around React/Tauri.

**Tech Stack:** React 19, TypeScript, Vite, Tauri 2, Rust, FastAPI.

**Spec:** `docs/superpowers/specs/2026-10-12-react-tauri-desktop-migration-design.md`

## Global Constraints

- Delete only the PySide6 desktop application at `apps/desktop` and its explicit launch references.
- Do not delete FastAPI APIs, common Python packages, migrations, Supabase configuration, or product history.
- React/Tauri is the sole desktop client; unconverted React menus must clearly state their transition status.
- Rust/Cargo installation acceptance remains pending until a Windows Rust toolchain is available.
- Run focused React verification and production build; do not run the full legacy suite per user instruction.

## Review Focus

- Root startup commands must not point to a deleted PySide6 script.
- Bootstrap and checks must not require the deleted desktop package.
- Documentation must not claim unconverted React menus are usable.
- Tauri configuration must remain the only desktop package configuration.
- Git deletion must not include server, common, migrations, or documentation history.

---

### Task 1: Remove the PySide6 application package

**Files:**
- Delete: `apps/desktop/`
- Modify: root workspace configuration and Python dependency files that reference `apps/desktop`

- [x] Identify every root configuration reference to `apps/desktop`.
- [x] Remove the package and only its configuration references.
- [x] Verify `git diff --check` and confirm server/common files were not deleted.
- [ ] Commit with `데스크톱: PySide6 클라이언트 제거` (사용자 요청 시).

### Task 2: Promote React/Tauri startup and documentation

**Files:**
- Delete: `scripts/run-desktop.ps1`
- Modify: `README.md`, bootstrap/check scripts, product parity and operation guides

- [x] Replace PySide6 launch instructions with React web preview and Tauri Native launch instructions.
- [x] Update validation scripts to exclude the removed Python desktop package.
- [x] Confirm root React startup scripts and package references exist.
- [x] Run focused React test and production build.
- [ ] Commit with `문서: React Tauri를 기본 데스크톱으로 전환` (사용자 요청 시).
