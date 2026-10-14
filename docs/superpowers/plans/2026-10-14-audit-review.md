# 감사 로그 조회·보관 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 감사 조회 API를 owner/admin 전용 앱 화면과 연결하고, append-only 보관 기본 정책을 운영 문서에 기록한다.

**Architecture:** React 화면은 `ApiClient.call`을 통해 기존 Fastify cursor API를 호출한다. 상단 더보기 메뉴는 owner/admin에만 표시하고 서버 권한 검사도 유지한다. retention은 법률·고객 정책이 정해지지 않았으므로 무기한 보관, 자동 삭제 없음으로 둔다.

**Tech Stack:** React 19, TypeScript, Zod, Vitest, Fastify API(기존 구현).

**Spec:** `docs/superpowers/specs/2026-10-14-audit-review-design.md`

## Global Constraints

- 조직 경계와 역할은 기존 API 및 RLS에서 검사한다.
- 감사 로그는 append-only로 읽기만 제공한다.
- 전체 테스트를 돌리지 않고 변경 API/UI 테스트와 빌드만 실행한다.
- 기존 미커밋 변경을 보존하고 커밋·푸시·실DB 변경을 하지 않는다.
- UI 토큰·스타일을 재설계하지 않는다.

## Review Focus

- 조직을 전환한 직후 이전 조직의 결과가 남지 않는지.
- member가 직접 메뉴를 열거나 API를 호출해도 조회가 거부되는지.
- 날짜/action 변경과 cursor 이동이 페이지 상태를 올바르게 초기화하는지.
- 네트워크 오류에서 필터가 유지되고 재시도가 가능한지.
- metadata가 sanitized 스칼라만 표시하고 임의 HTML로 렌더링되지 않는지.

---

### Task 1: Audit API client contract

**Files:** `apps/desktop-react/src/api/schemas.ts`, `client.ts`, `client.test.ts`

- [x] 감사 row/page Zod schema와 `listAuditEvents` 입력·반환 타입을 추가한다.
- [x] 호출 경로, query encoding, 인증 전달, payload 검증을 테스트한다.

### Task 2: Read-only audit page and menu route

**Files:** `apps/desktop-react/src/features/audit/AuditPage.tsx`, `AuditPage.test.tsx`, `features/shell/TopBar.tsx`, `menuCatalog.ts`, `app/Workspace.tsx`

- [x] owner/admin 전용 `audit` 메뉴를 추가한다.
- [x] 날짜·action 필터, 최신순 표, metadata, 다음/이전 페이지, 로딩·빈 상태·오류 재시도를 구현한다.
- [x] 권한 노출, 필터 초기화, pagination, 오류 후 재시도, organization 전환 입력을 검증한다.

### Task 3: Retention policy and status record

**Files:** `docs/guide/admin/deployment.md`, `docs/product/backlog.md`, `docs/product/changelog.md`, `docs/product/roadmap.md`

- [x] 감사로그는 append-only 무기한 보관, 자동 파기 없음으로 기록하고 보관 비용 및 정책 승인 필요를 명시한다.
- [x] TRT-11은 SQL 적용 성공(사용자 보고) 및 실계정 권한 인수 대기를 반영한다.
- [x] SEC-10 코드 검증 결과와 남은 운영 한계를 기록한다.

### Task 4: Focused verification

- [x] 변경 API/UI 테스트, API/React 빌드, `git diff --check`를 실행한다. 전체 테스트는 실행하지 않는다.
