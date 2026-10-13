# React/Tauri 고객관리 수직 기능 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 기존 PySide6 앱을 보존하면서 React/Tauri 앱에서 로그인·조직 선택·상단 앱 셸·대시보드·고객 목록/등록/수정·활동·사진의 실제 API 흐름을 완성한다.

**Architecture:** React 화면은 TanStack Query의 서버 상태와 Zustand의 세션·초안 상태를 사용하고, `Platform`과 `ApiClient` 인터페이스를 통해 브라우저 Vite 프록시 또는 Tauri Rust `reqwest`에 연결한다. 공통 시각 요소와 DataGrid는 `packages/react-ui`에 두며 FastAPI·Supabase 계약과 기존 `apps/desktop`은 유지한다.

**Tech Stack:** React 19, TypeScript 5, Vite, Tauri 2, TanStack Query 5, Zustand 5, Zod, Vitest, Testing Library, pnpm 11, Rust `reqwest`·`keyring`.

**Spec:** `docs/superpowers/specs/2026-10-12-react-tauri-desktop-migration-design.md`

## Global Constraints

- 기존 `apps/desktop` PySide6 코드와 실행 경로를 삭제하거나 React 앱으로 덮어쓰지 않는다.
- FastAPI와 Supabase 스키마를 첫 수직 기능 때문에 재설계하지 않고 현재 `/api/v1` 계약을 사용한다.
- 앱 배경 `#F7F3ED`, 패널 `#FFFDF9`, 보조 표면 `#EFE7DD`, 경계 `#DDD2C5`, 글자 `#332F2B`, 보조 글자 `#746B63`, 강조 `#A96F4F`, 선택 `#E9D7C8`을 사용한다.
- SUIT 고정 TTF 400·500·600·700, 본문·필드·버튼 13px, 표·보조 정보 12px, 제목 20~22px, 기본 표 행 34px를 기준으로 한다.
- 액세스 토큰은 메모리에만, 갱신 토큰은 Tauri에서 Windows Credential Manager에 보관한다. service role key는 번들에 포함하지 않는다.
- 개발은 Vite 프록시, 배포 앱은 Tauri `reqwest`를 사용하며 FastAPI에 광범위한 CORS를 추가하지 않는다.
- 고객 사진은 JPEG·PNG·WebP와 10MB 이하만 허용하고, 사진 오류가 프로필·활동 사용을 막지 않게 한다.
- 조직·역할·`crm.basic` 권한은 서버 결과를 최종 기준으로 하며 화면 숨김을 보안 경계로 사용하지 않는다.
- LCID에서 이식한 코드·자산은 `docs/product/react-lcid-provenance.md`에 원본 파일과 라이선스 판정을 남긴다. 배포 조건이 불명확한 코드는 동작만 참고해 새로 작성한다.
- 현재 PC에는 Rust/Cargo가 없으므로 React 검증과 Tauri 소스 검증을 분리하고, 실행하지 못한 Rust 검증을 통과로 기록하지 않는다.
- 전체 Python·Qt 회귀는 사용자가 요청하지 않았으므로 실행하지 않는다. 각 작업의 React 집중 테스트와 마지막 FastAPI 계약 집중 테스트만 실행한다.

## Review Focus

- 갱신 토큰이 없거나 만료된 시작 상태: 로그인 화면으로 돌아가며 반복 갱신이나 무한 로딩이 없어야 한다. Task 5의 세션 복원 테스트로 고정한다.
- 고객 A의 늦은 활동·사진 응답이 고객 B 상세를 덮는 경쟁 상태: 쿼리 키와 선택 ID가 일치하는 자료만 표시해야 한다. Task 9와 10의 전환 테스트로 고정한다.
- 메뉴 이동·고객 전환·창 닫기 중 수정된 폼: 저장, 버리기, 계속 작성 선택 전에는 이동하지 않아야 한다. Task 8의 이탈 보호 테스트로 고정한다.
- 사진 메타데이터 저장 후 Storage 업로드가 실패한 상태: 다른 고객 정보는 유지하고 실패한 사진에 재시도 가능한 오류를 표시해야 한다. Task 10의 부분 실패 테스트로 고정한다.
- member 또는 다른 조직 경로에서 쓰기 시도: 버튼 표시와 관계없이 서버 403/404를 성공으로 처리하지 않고 읽기 전용 또는 접근 오류로 설명해야 한다. Task 7·8의 권한 테스트로 고정한다.

---

## 파일 구조

### 작업공간

- `package.json`: pnpm 공통 명령과 Node/pnpm 버전 고정
- `pnpm-workspace.yaml`: `apps/desktop-react`, `packages/react-ui`
- `pnpm-lock.yaml`: 설치 잠금
- `.gitignore`: Node, Vite, Tauri 빌드 산출물

### 공통 UI

- `packages/react-ui/src/tokens.css`: 색상·글꼴·간격·상태 토큰
- `packages/react-ui/src/base.css`: HTML 컨트롤과 레이아웃 기본값
- `packages/react-ui/src/components/*`: Modal, Notice, Select, DateField, 상태 화면, DataGrid
- `packages/react-ui/src/index.ts`: 외부 공개 API만 재수출

### React 앱

- `apps/desktop-react/src/app/*`: 앱 조립, QueryClient, 라우팅, 오류 경계
- `apps/desktop-react/src/platform/*`: 브라우저·Tauri 전송, 파일, 토큰 저장 인터페이스
- `apps/desktop-react/src/api/*`: HTTP 계약, Zod 응답, 오류, 인증 갱신
- `apps/desktop-react/src/store/*`: 세션·선택 조직·초안
- `apps/desktop-react/src/features/*`: auth, shell, dashboard, customers, settings
- `apps/desktop-react/src-tauri/*`: 허용된 API 요청, 자격 증명, 업로드, 앱 기능

## Task 1: pnpm 작업공간과 React 실행 기준

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `apps/desktop-react/package.json`
- Create: `apps/desktop-react/tsconfig.json`
- Create: `apps/desktop-react/tsconfig.app.json`
- Create: `apps/desktop-react/vite.config.ts`
- Create: `apps/desktop-react/index.html`
- Create: `apps/desktop-react/src/main.tsx`
- Create: `apps/desktop-react/src/vite-env.d.ts`
- Create: `apps/desktop-react/src/test/setup.ts`
- Create: `packages/react-ui/package.json`
- Create: `packages/react-ui/tsconfig.json`
- Create: `packages/react-ui/src/index.ts`
- Modify: `.gitignore`

**Interfaces:**
- Consumes: 기존 FastAPI 기본 주소 `http://127.0.0.1:8000/api/v1`.
- Produces: `pnpm react:dev`, `pnpm react:test`, `pnpm react:build`, `REACT_UI_VERSION`, `@business-assistant/react-ui` 작업공간 해석.

- [ ] **Step 1: 작업공간 검증 스크립트를 작성한다**

`apps/desktop-react/src/app/workspace.test.ts`에서 React가 기본 화면을 렌더링하고 `@business-assistant/react-ui`의 `REACT_UI_VERSION`이 `0.1.0`인지 단언하는 실패 테스트를 작성한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --dir apps/desktop-react test --run src/app/workspace.test.ts`  
Expected: 패키지와 Vite 설정이 없어 FAIL.

- [ ] **Step 3: 최소 작업공간을 구성한다**

루트 `package.json`은 `packageManager: pnpm@11.19.0`, Node `>=24`, 스크립트 `react:dev`, `react:test`, `react:build`를 제공한다. 앱은 LCID와 맞춘 React `^19.3.0`, TanStack Query `^5.104.1`, Zustand `^5.0.15`, Vite `^8.3.4`, Vitest `^5.0.3`과 Zod를 의존한다. 공통 UI 패키지는 이 작업에서 빈 공개 진입점과 `REACT_UI_VERSION = '0.1.0'`을 제공한다. Vite는 `/api/v1`을 `VITE_API_PROXY_TARGET` 또는 `http://127.0.0.1:8000`으로 프록시한다.

- [ ] **Step 4: 설치와 집중 테스트를 실행한다**

Run: `pnpm install && pnpm --dir apps/desktop-react test --run src/app/workspace.test.ts`  
Expected: PASS, `pnpm-lock.yaml` 생성.

- [ ] **Step 5: 커밋 체크포인트**

```powershell
git add package.json pnpm-workspace.yaml pnpm-lock.yaml .gitignore apps/desktop-react packages/react-ui
git commit -m "데스크톱: React 작업공간 구성"
```

## Task 2: LCID 출처 기록과 베이지 디자인 토큰

**Files:**
- Modify: `packages/react-ui/package.json`
- Modify: `packages/react-ui/tsconfig.json`
- Create: `packages/react-ui/src/tokens.css`
- Create: `packages/react-ui/src/base.css`
- Modify: `packages/react-ui/src/index.ts`
- Create: `packages/react-ui/src/style-contract.test.ts`
- Create: `apps/desktop-react/src/assets/fonts/SUIT-Regular.ttf`
- Create: `apps/desktop-react/src/assets/fonts/SUIT-Medium.ttf`
- Create: `apps/desktop-react/src/assets/fonts/SUIT-SemiBold.ttf`
- Create: `apps/desktop-react/src/assets/fonts/SUIT-Bold.ttf`
- Create: `apps/desktop-react/src/assets/fonts/SUIT-LICENSE.txt`
- Create: `docs/product/react-lcid-provenance.md`

**Interfaces:**
- Consumes: PySide 자산의 SUIT 고정 TTF와 `D:\LCID\packages\ui`의 구조·동작 참고.
- Produces: CSS 변수 `--surface-app`, `--surface-panel`, `--surface-muted`, `--border`, `--text`, `--text-muted`, `--accent`, `--selection`; `@business-assistant/react-ui/base.css`.

- [ ] **Step 1: 토큰 계약 테스트를 작성한다**

`style-contract.test.ts`에서 여덟 색상 값, 네 개 `@font-face`, 13px 기본 글꼴, 34px 데이터 행 변수와 `:focus-visible` 규칙을 읽어 단언한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --dir packages/react-ui test --run src/style-contract.test.ts`  
Expected: CSS 파일이 없어 FAIL.

- [ ] **Step 3: 토큰·기본 CSS와 글꼴을 추가한다**

SUIT 파일과 라이선스를 기존 PySide 자산에서 복사한다. 클릭 뒤 남는 일반 outline은 제거하되 키보드 `:focus-visible`에는 2px 강조 링을 표시한다. Select 화살표는 CSS 또는 저장소 자체 SVG로 구현한다.

- [ ] **Step 4: 출처 문서를 작성한다**

`react-lcid-provenance.md`에 참고한 LCID 파일, 이식/재작성 판정, 외부 패키지명과 라이선스 확인 위치를 표로 남긴다. LCID 루트에 독립 LICENSE가 없는 사실도 숨기지 않고, 그대로 복사한 코드가 있으면 배포 전에 권리 확인이 필요하다고 기록한다.

- [ ] **Step 5: 테스트와 글꼴 해시를 확인한다**

Run: `pnpm --dir packages/react-ui test --run src/style-contract.test.ts`  
Expected: PASS. 네 TTF와 라이선스 파일이 비어 있지 않음.

- [ ] **Step 6: 커밋 체크포인트**

```powershell
git add packages/react-ui apps/desktop-react/src/assets/fonts docs/product/react-lcid-provenance.md
git commit -m "데스크톱: React 디자인 토큰과 서체 추가"
```

## Task 3: 공통 컨트롤·팝업·상태 표현

**Files:**
- Create: `packages/react-ui/src/components/Modal.tsx`
- Create: `packages/react-ui/src/components/Modal.test.tsx`
- Create: `packages/react-ui/src/components/NoticeHost.tsx`
- Create: `packages/react-ui/src/components/notices.ts`
- Create: `packages/react-ui/src/components/ConfirmDialog.tsx`
- Create: `packages/react-ui/src/components/Select.tsx`
- Create: `packages/react-ui/src/components/DateField.tsx`
- Create: `packages/react-ui/src/components/DateTimeField.tsx`
- Create: `packages/react-ui/src/components/DateRangeField.tsx`
- Create: `packages/react-ui/src/components/States.tsx`
- Modify: `packages/react-ui/src/index.ts`

**Interfaces:**
- Produces: `Modal(props)`, `confirm(request): Promise<boolean>`, `notify.success/error(message)`, `Select<Option>`, `DateField`, `DateTimeField`, `DateRangeField`, `LoadingState`, `EmptyState`, `ErrorState`.

- [ ] **Step 1: 모달과 컨트롤 실패 테스트를 작성한다**

`Modal.test.tsx`에 최초 포커스, Tab 포커스 고정, ESC 정책, 닫은 뒤 트리거 포커스 복귀, 취소 확인, Select 키보드 탐색, 날짜 ISO 값 전달을 각각 단언한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --dir packages/react-ui test --run src/components/Modal.test.tsx`  
Expected: 공개 구성 요소가 없어 FAIL.

- [ ] **Step 3: 공통 구성 요소를 구현한다**

`Modal`은 `title`, `size`, `closeOnBackdrop`, `onClose`, `initialFocusRef`를 받는다. 날짜 구성 요소는 화면 표시와 API ISO 값을 분리하고 잘못된 날짜를 `onChange`로 전달하지 않는다.

- [ ] **Step 4: 집중 테스트를 통과시킨다**

Run: `pnpm --dir packages/react-ui test --run src/components/Modal.test.tsx`  
Expected: PASS.

- [ ] **Step 5: 커밋 체크포인트**

```powershell
git add packages/react-ui/src
git commit -m "데스크톱: React 공통 팝업과 입력 컨트롤 추가"
```

## Task 4: 업무용 DataGrid

**Files:**
- Create: `packages/react-ui/src/components/DataGrid.tsx`
- Create: `packages/react-ui/src/components/DataGrid.test.tsx`
- Create: `packages/react-ui/src/components/gridWidths.ts`
- Modify: `packages/react-ui/src/index.ts`

**Interfaces:**
- Produces: `Column<T>`, `SortState`, `DataGridProps<T>`, `DataGrid<T>(props)`, `loadWidths(key)`, `saveWidths(key, widths)`.
- `DataGridProps<T>`: `rows`, `columns`, `rowKey`, `selectedKey`, `onSelect`, `onActivate`, `loading`, `emptyText`, `storageKey`, `ariaLabel`.

- [ ] **Step 1: 표 상호작용 실패 테스트를 작성한다**

정렬, 행 선택, 위·아래 키 이동, Enter·더블클릭 활성화, 셀 Ctrl+C, 열 너비 localStorage 저장, 로딩·빈 결과를 각각 단언한다. 손상된 localStorage JSON은 기본 너비로 복구해야 한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --dir packages/react-ui test --run src/components/DataGrid.test.tsx`  
Expected: DataGrid가 없어 FAIL.

- [ ] **Step 3: DataGrid를 구현한다**

LCID 동작을 참고하되 제품 저장소의 새 구현으로 작성한다. 표 헤더는 고정하고 기본 행 높이 34px를 사용한다. 금액·상태 변경용 인라인 쓰기 API는 이 단계에서 만들지 않는다.

- [ ] **Step 4: 집중 테스트를 통과시킨다**

Run: `pnpm --dir packages/react-ui test --run src/components/DataGrid.test.tsx`  
Expected: PASS.

- [ ] **Step 5: 커밋 체크포인트**

```powershell
git add packages/react-ui/src/components packages/react-ui/src/index.ts
git commit -m "데스크톱: React 업무용 데이터 표 추가"
```

## Task 5: 플랫폼 전송과 인증 API 클라이언트

**Files:**
- Create: `apps/desktop-react/src/platform/types.ts`
- Create: `apps/desktop-react/src/platform/browser.ts`
- Create: `apps/desktop-react/src/api/transport.ts`
- Create: `apps/desktop-react/src/api/errors.ts`
- Create: `apps/desktop-react/src/api/schemas.ts`
- Create: `apps/desktop-react/src/api/client.ts`
- Create: `apps/desktop-react/src/api/client.test.ts`

**Interfaces:**
- Produces: `BinarySource = { kind: 'blob'; name; contentType; size; blob } | { kind: 'path'; name; contentType; size; path }`.
- Produces: `HttpRequest { method, path, headers, body? }`, `HttpResponse { status, body, headers }`, `HttpTransport(request): Promise<HttpResponse>`.
- Produces: `Platform { kind, apiBase, request, uploadBinary(url, source), downloadBinary(url), tokenStore, pickImages?, autostart?, checkUpdate? }`와 `ConnectionState = 'checking' | 'online' | 'offline'` 구독.
- Produces: `ApiClient.login(email, password)`, `restoreSession()`, `logout()`, `listOrganizations()`, `getEntitlements(organizationId)`.
- Produces: `ApiError { status, code, message, retryable, requestId? }`.

- [ ] **Step 1: API 실패 테스트를 작성한다**

로그인 응답 검증, Bearer 헤더, 동시 401의 단일 `/auth/refresh`, 갱신 실패 시 토큰 삭제, 403 비재시도, 503 재시도 가능 표시, 잘못된 JSON 거절을 단언한다. 갱신 토큰이 없는 `restoreSession()`은 로그인 필요 결과를 즉시 반환해야 한다. 성공한 요청은 연결 상태를 `online`, 네트워크 실패는 `offline`, 재시도 시작은 `checking`으로 알린다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --dir apps/desktop-react test --run src/api/client.test.ts`  
Expected: ApiClient가 없어 FAIL.

- [ ] **Step 3: 브라우저 플랫폼과 ApiClient를 구현한다**

브라우저 API 기준은 `/api/v1`, 토큰 저장은 개발 탭의 `sessionStorage`로 한정한다. 응답은 Zod로 검증하며 액세스 토큰은 ApiClient 인스턴스 메모리에만 둔다. `downloadBinary`는 `Uint8Array`, `uploadBinary`는 성공 시 `void`를 반환한다.

- [ ] **Step 4: 집중 테스트를 통과시킨다**

Run: `pnpm --dir apps/desktop-react test --run src/api/client.test.ts`  
Expected: PASS.

- [ ] **Step 5: 커밋 체크포인트**

```powershell
git add apps/desktop-react/src/platform apps/desktop-react/src/api
git commit -m "데스크톱: React API와 인증 전송 계층 추가"
```

## Task 6: Tauri 보안 전송·자격 증명·파일 기능

**Files:**
- Create: `apps/desktop-react/src/platform/tauri.ts`
- Create: `apps/desktop-react/src/platform/tauri.test.ts`
- Create: `apps/desktop-react/src-tauri/Cargo.toml`
- Create: `apps/desktop-react/src-tauri/tauri.conf.json`
- Create: `apps/desktop-react/src-tauri/capabilities/default.json`
- Create: `apps/desktop-react/src-tauri/src/main.rs`
- Create: `apps/desktop-react/src-tauri/src/lib.rs`
- Create: `apps/desktop-react/src-tauri/src/http.rs`
- Create: `apps/desktop-react/src-tauri/src/credentials.rs`
- Create: `apps/desktop-react/src-tauri/src/files.rs`
- Create: `apps/desktop-react/src-tauri/src/config.rs`

**Interfaces:**
- Consumes: Task 5의 `Platform`, `HttpRequest`, `HttpResponse`.
- Produces Tauri commands: `get_config`, `http_request`, `upload_binary`, `download_binary`, `token_load`, `token_save`, `token_clear`, `pick_images`, `autostart_is_enabled`, `autostart_set`.

- [ ] **Step 1: TypeScript Tauri 어댑터 실패 테스트를 작성한다**

invoke 명령 이름과 인수, 취소된 파일 선택, Rust 오류의 `ApiError` 변환, 토큰 저장 호출을 단언한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --dir apps/desktop-react test --run src/platform/tauri.test.ts`  
Expected: Tauri 어댑터가 없어 FAIL.

- [ ] **Step 3: TypeScript 어댑터를 구현한다**

기능 화면이 `@tauri-apps/*`를 직접 가져오지 않도록 모든 호출을 `tauri.ts`에 둔다.

- [ ] **Step 4: Rust 명령과 단위 테스트를 작성한다**

`tauri.conf.json`은 productName `Business Assistant`, identifier `com.businessassistant.desktop`을 사용한다. TypeScript는 LCID와 맞춘 `@tauri-apps/api ^2.12.1`, CLI `^2.12.1`, dialog `^2.8.1`, autostart `^2.7.0`을 사용한다. Rust는 Tauri 2, `reqwest 0.12`의 `native-tls`, `keyring 3`의 `windows-native`를 사용한다. `config.rs`는 개발 `http://127.0.0.1`과 배포 HTTPS API만 허용하고, 사진 서명 URL은 `BUSINESS_ASSISTANT_STORAGE_HOST`에 지정된 HTTPS 호스트만 허용한다. `http.rs`는 API 기준 URL 밖의 일반 요청과 `..` 경로를 거절한다. `credentials.rs`의 keyring service는 `business-assistant`, account는 `refresh-token`을 사용한다. `files.rs`는 JPEG·PNG·WebP, 10MB 이하, 안전한 파일명만 통과시킨다.

- [ ] **Step 5: 가능한 검증을 분리 실행한다**

Run now: `pnpm --dir apps/desktop-react test --run src/platform/tauri.test.ts`  
Expected: PASS.  
Run when Rust is available: `cargo test --manifest-path apps/desktop-react/src-tauri/Cargo.toml`  
Expected: URL·경로·자격 증명 키·파일 검증 테스트 PASS. Rust 미설치 환경에서는 대기 사유를 문서에 기록한다.

- [ ] **Step 6: 커밋 체크포인트**

```powershell
git add apps/desktop-react/src/platform/tauri.ts apps/desktop-react/src/platform/tauri.test.ts apps/desktop-react/src-tauri
git commit -m "데스크톱: Tauri 보안 통신과 자격 증명 구성"
```

## Task 7: 세션·조직 선택과 상단 앱 셸

**Files:**
- Create: `apps/desktop-react/src/store/session.ts`
- Create: `apps/desktop-react/src/app/services.ts`
- Create: `apps/desktop-react/src/app/App.tsx`
- Create: `apps/desktop-react/src/app/App.test.tsx`
- Create: `apps/desktop-react/src/features/auth/LoginView.tsx`
- Create: `apps/desktop-react/src/features/auth/OrganizationPicker.tsx`
- Create: `apps/desktop-react/src/features/shell/TopBar.tsx`
- Create: `apps/desktop-react/src/features/shell/ConnectionBadge.tsx`
- Create: `apps/desktop-react/src/features/settings/SettingsDialog.tsx`
- Modify: `apps/desktop-react/src/main.tsx`

**Interfaces:**
- Consumes: Task 3 notice/confirm, Task 5 ApiClient·ConnectionState, Task 6 Platform.
- Produces: `useSessionStore`, `AppServices`, `TopBar`, 메뉴 ID `dashboard|customers|appointments|treatments|sales|memberships|inventory|staff|finance|documents|files`.

- [ ] **Step 1: 앱 시작 실패 테스트를 작성한다**

로그인 성공 후 조직이 하나면 자동 선택, 여러 개면 선택 창, 조직이 없으면 안내, `crm.basic`이 없으면 고객 메뉴 숨김, member는 고객 화면 읽기 전용, 복원 실패는 로그인 복귀, 403은 권한 메시지 표시를 단언한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --dir apps/desktop-react test --run src/app/App.test.tsx`  
Expected: 앱 셸이 없어 FAIL.

- [ ] **Step 3: 세션과 상단 메뉴를 구현한다**

핵심 메뉴는 가운데, 매장명은 왼쪽, 연결·사용자·설정·로그아웃은 오른쪽에 둔다. 좁은 폭에서는 확장 업무를 `더보기` 팝업으로 이동한다. 미구현 메뉴는 클릭 가능한 가짜 화면이 아니라 `아직 React 전환 전` 상태와 PySide6 사용 안내를 표시한다.

- [ ] **Step 4: 설정 기능을 연결한다**

자동 실행은 Platform capability가 있을 때만 조작 가능하게 한다. 업데이트 확인은 이번 수직 기능에서 상태 자리만 제공하며 `checkUpdate`가 없는 브라우저와 초기 Tauri 구성에서는 `패키징 단계에서 지원 예정`으로 표시한다.

- [ ] **Step 5: 집중 테스트를 통과시킨다**

Run: `pnpm --dir apps/desktop-react test --run src/app/App.test.tsx`  
Expected: PASS.

- [ ] **Step 6: 커밋 체크포인트**

```powershell
git add apps/desktop-react/src/app apps/desktop-react/src/store apps/desktop-react/src/features/auth apps/desktop-react/src/features/shell apps/desktop-react/src/features/settings apps/desktop-react/src/main.tsx
git commit -m "데스크톱: React 로그인과 상단 앱 셸 연결"
```

## Task 8: 고객 API, 목록과 프로필 초안 보호

**Files:**
- Create: `apps/desktop-react/src/features/customers/types.ts`
- Create: `apps/desktop-react/src/features/customers/api.ts`
- Create: `apps/desktop-react/src/features/customers/queries.ts`
- Create: `apps/desktop-react/src/features/customers/drafts.ts`
- Create: `apps/desktop-react/src/features/customers/CustomerPage.tsx`
- Create: `apps/desktop-react/src/features/customers/CustomerGrid.tsx`
- Create: `apps/desktop-react/src/features/customers/CustomerForm.tsx`
- Create: `apps/desktop-react/src/features/customers/CustomerPage.test.tsx`
- Modify: `apps/desktop-react/src/api/schemas.ts`
- Modify: `apps/desktop-react/src/api/client.ts`

**Interfaces:**
- Produces: `Customer`, `CustomerInput`, `customerKeys`, `useCustomerDraftStore`, `CustomerPage`.
- API: `listCustomers(orgId)`, `createCustomer(orgId, input)`, `updateCustomer(orgId, customerId, patch)`, `archiveCustomer(orgId, customerId)`.

- [ ] **Step 1: 고객 화면 실패 테스트를 작성한다**

이름·전화·태그 검색, active/archived 필터, 표 정렬·선택, 등록·수정 성공 후 관련 쿼리만 갱신, member 읽기 전용, 403/404 설명, 503 재시도, 고객 전환·메뉴 이동·창 닫기 초안 확인을 단언한다.

- [ ] **Step 2: 경쟁·이탈 보호 실패를 확인한다**

Run: `pnpm --dir apps/desktop-react test --run src/features/customers/CustomerPage.test.tsx`  
Expected: 고객 기능이 없어 FAIL.

- [ ] **Step 3: 고객 Zod 계약과 쿼리를 구현한다**

서버 필드 `id`, `organization_id`, `name`, `email`, `phone`, `notes`, `birth_date`, `skin_type`, `concerns`, `allergies`, `last_visit_date`, `next_visit_date`, `tags`, `status`를 그대로 검증한다.

- [ ] **Step 4: 목록·폼·초안 보호를 구현한다**

초안 키는 `${organizationId}:customers:${customerId ?? 'new'}`이다. 성공 응답 전에는 초안을 지우지 않는다. 보관은 영구 삭제처럼 표현하지 않고 상태 변경으로 안내한다.

- [ ] **Step 5: 집중 테스트를 통과시킨다**

Run: `pnpm --dir apps/desktop-react test --run src/features/customers/CustomerPage.test.tsx`  
Expected: PASS.

- [ ] **Step 6: 커밋 체크포인트**

```powershell
git add apps/desktop-react/src/features/customers apps/desktop-react/src/api
git commit -m "데스크톱: React 고객 목록과 프로필 편집 구현"
```

## Task 9: 고객 활동 타임라인

**Files:**
- Create: `apps/desktop-react/src/features/customers/activities/ActivityPanel.tsx`
- Create: `apps/desktop-react/src/features/customers/activities/ActivityPanel.test.tsx`
- Create: `apps/desktop-react/src/features/customers/activities/api.ts`
- Modify: `apps/desktop-react/src/features/customers/CustomerPage.tsx`
- Modify: `apps/desktop-react/src/api/schemas.ts`
- Modify: `apps/desktop-react/src/api/client.ts`

**Interfaces:**
- Produces: `CustomerActivity`, `ActivityInput`, `activityKeys.detail(orgId, customerId)`, `ActivityPanel`.
- API: `listCustomerActivities`, `createCustomerActivity`, `deleteCustomerActivity`.

- [ ] **Step 1: 활동 독립 조회 실패 테스트를 작성한다**

고객 선택 뒤 활동 로딩, 빈 상태, 등록·삭제 권한, 실패 시 작성 내용 보존, 고객 A 요청이 늦게 끝나도 고객 B에 표시되지 않음, 활동 503이 프로필 사용을 막지 않음을 단언한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --dir apps/desktop-react test --run src/features/customers/activities/ActivityPanel.test.tsx`  
Expected: ActivityPanel이 없어 FAIL.

- [ ] **Step 3: 활동 API와 패널을 구현한다**

`occurred_at`은 `DateTimeField`에서 ISO 문자열로 전송한다. 활동 설명을 HTML로 해석하지 않고 일반 텍스트로 렌더링한다.

- [ ] **Step 4: 집중 테스트를 통과시킨다**

Run: `pnpm --dir apps/desktop-react test --run src/features/customers/activities/ActivityPanel.test.tsx`  
Expected: PASS.

- [ ] **Step 5: 커밋 체크포인트**

```powershell
git add apps/desktop-react/src/features/customers/activities apps/desktop-react/src/features/customers/CustomerPage.tsx apps/desktop-react/src/api
git commit -m "데스크톱: React 고객 활동 타임라인 연결"
```

## Task 10: 고객 사진 조회·업로드·부분 실패 복구

**Files:**
- Create: `apps/desktop-react/src/features/customers/photos/PhotoPanel.tsx`
- Create: `apps/desktop-react/src/features/customers/photos/PhotoPanel.test.tsx`
- Create: `apps/desktop-react/src/features/customers/photos/api.ts`
- Create: `apps/desktop-react/src/features/customers/photos/photoValidation.ts`
- Modify: `apps/desktop-react/src/features/customers/CustomerPage.tsx`
- Modify: `apps/desktop-react/src/api/schemas.ts`
- Modify: `apps/desktop-react/src/api/client.ts`

**Interfaces:**
- Consumes: `Platform.pickImages`, `Platform.uploadBinary`, `Platform.downloadBinary`.
- Produces: `CustomerPhoto`, `SignedPhoto`, `photoKeys.list(orgId, customerId)`, `PhotoPanel`.
- API: `listCustomerPhotos`, `createPhotoUploadUrl`, `createPhotoDownloadUrl`, `archiveCustomerPhoto`.

- [ ] **Step 1: 사진 실패·경쟁 상태 테스트를 작성한다**

형식·10MB 검증, 빈 상태, 여러 사진 목록, 다운로드 URL 만료 재발급, 고객 전환 시 이전 응답 무시, 업로드 준비 503, Storage PUT 실패 뒤 메타데이터 보관 처리, 특정 사진 다운로드 실패가 프로필·활동과 다른 사진을 막지 않음을 단언한다. 보관 처리까지 실패하면 사용자에게 미완료 사진 ID와 재시도 수단을 남겨야 한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --dir apps/desktop-react test --run src/features/customers/photos/PhotoPanel.test.tsx`  
Expected: PhotoPanel이 없어 FAIL.

- [ ] **Step 3: 사진 API와 플랫폼 업로드를 구현한다**

서명 URL은 로그·영구 상태에 저장하지 않는다. 브라우저는 Blob, Tauri는 파일 경로/바이트 명령으로 업로드한다. Storage PUT 실패 시 준비 단계에서 생성된 사진을 `archiveCustomerPhoto`로 보상 처리한다. 오류 카드는 파일명과 재시도 버튼을 유지하고, 보상 처리도 실패하면 사진 ID를 포함한 복구 안내를 표시한다.

- [ ] **Step 4: 집중 테스트를 통과시킨다**

Run: `pnpm --dir apps/desktop-react test --run src/features/customers/photos/PhotoPanel.test.tsx`  
Expected: PASS.

- [ ] **Step 5: 커밋 체크포인트**

```powershell
git add apps/desktop-react/src/features/customers/photos apps/desktop-react/src/features/customers/CustomerPage.tsx apps/desktop-react/src/api
git commit -m "데스크톱: React 고객 사진 등록과 오류 복구 연결"
```

## Task 11: 실제 데이터 기반 대시보드와 앱 통합

**Files:**
- Create: `apps/desktop-react/src/features/dashboard/DashboardPage.tsx`
- Create: `apps/desktop-react/src/features/dashboard/DashboardPage.test.tsx`
- Create: `apps/desktop-react/src/features/dashboard/useDashboardData.ts`
- Create: `apps/desktop-react/src/app/routes.tsx`
- Modify: `apps/desktop-react/src/app/App.tsx`
- Modify: `apps/desktop-react/src/api/client.ts`
- Modify: `apps/desktop-react/src/api/schemas.ts`
- Modify: `apps/desktop-react/src/features/shell/TopBar.tsx`

**Interfaces:**
- Consumes: 기존 고객 목록과 기존 `/organizations/{id}/tasks` 조회 중 성공한 실제 자료만 사용.
- Produces: `ApiClient.listTasks(organizationId)`, `DashboardPage`, `AppRoute`, 고객·할 일 원본 화면 이동.

- [ ] **Step 1: 대시보드 진실성 실패 테스트를 작성한다**

고객 수·오늘 할 일은 실제 응답에서만 계산하고, 원천 실패 시 0으로 위장하지 않고 `수집 불가`로 표시하며, KPI 클릭은 해당 필터 화면으로 이동해야 한다.

- [ ] **Step 2: 실패를 확인한다**

Run: `pnpm --dir apps/desktop-react test --run src/features/dashboard/DashboardPage.test.tsx`  
Expected: DashboardPage가 없어 FAIL.

- [ ] **Step 3: 대시보드와 라우팅을 구현한다**

서버에 없는 가상 매출·예약 지표를 추가하지 않는다. 한 원천이 실패해도 나머지 카드는 표시한다.

- [ ] **Step 4: 집중 테스트를 통과시킨다**

Run: `pnpm --dir apps/desktop-react test --run src/features/dashboard/DashboardPage.test.tsx src/app/App.test.tsx`  
Expected: PASS.

- [ ] **Step 5: 커밋 체크포인트**

```powershell
git add apps/desktop-react/src/features/dashboard apps/desktop-react/src/app apps/desktop-react/src/api apps/desktop-react/src/features/shell
git commit -m "데스크톱: React 대시보드와 고객 화면 통합"
```

## Task 12: 첫 수직 기능 인수와 운영 문서

**Files:**
- Create: `apps/desktop-react/src/app/vertical-slice.test.tsx`
- Create: `scripts/run-react-desktop.ps1`
- Create: `scripts/run-react-web.ps1`
- Create: `docs/guide/admin/react-tauri.md`
- Create: `docs/product/react-tauri-parity.md`
- Modify: `docs/product/design-system.md`
- Modify: `docs/product/roadmap.md`
- Modify: `docs/product/changelog.md`
- Modify: `README.md`

**Interfaces:**
- Produces: 두 터미널 실행 방법, React/PySide 기능 동등성 표, UI-002 검증 기록.

- [ ] **Step 1: 전체 사용자 동선 테스트를 작성한다**

로그인 → 조직 선택 → 고객 검색 → 고객 등록 → 수정 → 활동 등록 → 사진 업로드 URL 준비 → Storage PUT → 사진 목록 재조회 → 다른 고객 전환 → 로그아웃을 모의 API로 검증한다. 403, 503, 네트워크 단절, 초안 취소도 포함한다.

- [ ] **Step 2: React 집중 검증을 실행한다**

Run: `pnpm react:test -- --run`  
Expected: React와 `react-ui` 테스트 PASS.  
Run: `pnpm react:build`  
Expected: TypeScript와 Vite production build PASS.

- [ ] **Step 3: FastAPI 계약 집중 검증을 실행한다**

Run: `.venv\Scripts\python.exe -m pytest apps/server/tests/test_auth_api.py apps/server/tests/test_entitlement_api.py apps/server/tests/test_customer_api.py apps/server/tests/test_photo_preparation_cleanup.py apps/server/tests/test_organization_service.py -q`  
Expected: 관련 인증·권한·고객·사진 준비 계약 테스트 PASS.

- [ ] **Step 4: 브라우저 수동 인수를 수행한다**

서버와 `pnpm react:dev`를 별도 터미널에서 실행한다. 1280×720, 1440×900 및 Windows 100%, 125%, 150%에서 로그인, 상단 메뉴, 고객 목록·폼·활동·사진, 키보드 포커스, Select·날짜·팝업을 확인한다. 실제 고객 자료 대신 명시된 테스트 조직을 사용한다.

- [ ] **Step 5: Tauri 인수를 환경에 따라 기록한다**

Rust가 있으면 `pnpm --dir apps/desktop-react tauri build`와 설치 앱 흐름을 확인한다. 현재 PC처럼 Rust가 없으면 `pending-rust-toolchain`으로 기록하고 UI-002를 `verified`로 올리지 않는다.

- [ ] **Step 6: 문서 상태를 정확히 갱신한다**

통과한 범위만 UI-002 `in-progress` 검증 기록에 추가하고, 예약 이후 React 기능과 Windows 설치 인수는 미완료로 남긴다. PySide6 제거 조건은 변경하지 않는다.

- [ ] **Step 7: 최종 커밋 체크포인트**

```powershell
git add apps/desktop-react scripts/run-react-desktop.ps1 scripts/run-react-web.ps1 docs README.md
git commit -m "문서: React 데스크톱 실행과 기능 검증 기록"
```

## 후속 계획 경계

이 계획이 끝난 뒤 다음 계획을 순서대로 별도 작성한다.

1. React 예약·달력·담당자·공간·장비 전환
2. React 상담·시술·문서 전환
3. React 결제·매출·회원권 전환
4. React 상품·재고·엑셀 입출력 전환
5. React 직원·근태·수당 전환
6. React 정산·손익·원본 드릴다운 전환
7. 공지·후속 업무·실시간 이벤트·자동 업데이트 운영 완성

각 계획은 UI-002의 동일한 플랫폼과 공통 UI 계약을 사용하고, 기능 동등성 표의 해당 행이 통과하기 전에는 PySide6 책임을 종료하지 않는다.
