# 공통 메뉴 기본 기능 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 모든 구독 메뉴를 최소한의 조회·생성·수정·삭제 또는 기본 동작까지 사용할 수 있는 데스크톱 업무 앱으로 연결한다.

**Architecture:** 기존 FastAPI API와 entitlement를 유지하고, PySide6의 공통 `AppShell`, API client DTO, 목록·폼·상태 컴포넌트를 재사용한다. 메뉴별 화면은 독립 위젯으로 분리하며 서버 호출은 인증 세션과 조직 ID를 항상 전달한다.

**Tech Stack:** Python 3.13, PySide6, qt-material(BSD-2-Clause), FastAPI, httpx, pytest-qt.

**Spec:** `docs/superpowers/specs/2026-09-17-product-ui-ux-design.md`

## Global Constraints

- 서버 권한 검사는 모든 보호 API 요청에서 유지한다.
- 데스크톱에 service-role 키를 넣지 않는다.
- 네트워크 작업은 UI 스레드를 차단하지 않는다.
- 모든 변경은 실패 테스트 → 최소 구현 → 전체 검증 순서로 진행한다.
- 커밋 메시지는 한글로 작성하고 완료 단계마다 `main`에 push한다.

---

### Task 1: 공통 API 모델과 AppShell 컨텍스트

**Files:**
- Modify: `apps/desktop/src/business_assistant_desktop/api_client.py`
- Modify: `apps/desktop/src/business_assistant_desktop/app.py`
- Modify: `apps/desktop/src/business_assistant_desktop/main_window.py`
- Test: `apps/desktop/tests/test_api_client.py`, `apps/desktop/tests/test_main_window.py`

- [ ] API client에 조직 컨텍스트를 받는 `list_customers`, `create_customer`, `update_customer`, `delete_customer` 메서드를 추가한다.
- [ ] `MainWindow`가 `ApiClient`, `Session`, `Organization`을 보관하고 선택 조직 ID를 모든 화면에 전달한다.
- [ ] API 호출 상태를 `idle/loading/success/empty/error`로 표시할 공통 `StatusBanner` 위젯을 추가한다.
- [ ] 실패 테스트로 DTO 직렬화, bearer 헤더, 조직 ID 경로를 검증한 뒤 전체 데스크톱 테스트를 실행한다.

### Task 2: 고객·거래처 기본 화면

**Files:**
- Create: `apps/desktop/src/business_assistant_desktop/customer_page.py`
- Modify: `apps/desktop/src/business_assistant_desktop/main_window.py`
- Test: `apps/desktop/tests/test_customer_page.py`

- [ ] 고객 목록을 표로 표시하고 이름·이메일 검색을 로컬 필터로 제공한다.
- [ ] owner/admin에게 생성·수정·보관 버튼을 제공하고 member는 조회만 허용한다.
- [ ] 저장 중 버튼을 잠그고 성공·빈 목록·403·503 상태를 표시한다.
- [ ] 테스트에서 가짜 API client로 목록 표시와 생성 검증을 수행한다.

### Task 3: 일정·할 일 기본 화면

**Files:**
- Modify: `apps/desktop/src/business_assistant_desktop/api_client.py`
- Create: `apps/desktop/src/business_assistant_desktop/task_page.py`
- Modify: `apps/desktop/src/business_assistant_desktop/main_window.py`
- Test: `apps/desktop/tests/test_task_page.py`

- [ ] 작업 목록과 상태 필터를 표시한다.
- [ ] 제목·설명·상태·우선순위·마감일 생성/수정 폼을 연결한다.
- [ ] 생성자 또는 관리자만 수정·삭제할 수 있도록 서버 오류를 그대로 안내한다.
- [ ] 상태 필터, 빈 상태, 잘못된 입력의 UI 테스트를 추가한다.

### Task 4: 문서·재무·파일 기본 화면

**Files:**
- Create: `apps/desktop/src/business_assistant_desktop/document_page.py`
- Create: `apps/desktop/src/business_assistant_desktop/finance_page.py`
- Create: `apps/desktop/src/business_assistant_desktop/file_page.py`
- Modify: `apps/desktop/src/business_assistant_desktop/api_client.py`, `main_window.py`
- Test: `apps/desktop/tests/test_document_page.py`, `test_finance_page.py`, `test_file_page.py`

- [ ] 문서 템플릿·문서 목록과 기본 작성 폼을 제공한다.
- [ ] 수입·지출 표, 유형·기간 필터, 합계 카드를 제공한다.
- [ ] 파일 목록, 업로드 파일 선택, signed URL 다운로드, 보관 처리를 제공한다.
- [ ] 각 화면의 로딩·빈 상태·오류·권한 부족 테스트를 추가한다.

### Task 5: 가져오기·내보내기와 보고서 기본 기능

**Files:**
- Create: `apps/server/src/business_assistant_server/api/data_transfer.py`
- Create: `apps/desktop/src/business_assistant_desktop/data_transfer_page.py`
- Create: `apps/desktop/src/business_assistant_desktop/report_page.py`
- Test: `apps/server/tests/test_data_transfer_api.py`, `apps/desktop/tests/test_data_transfer_page.py`, `test_report_page.py`

- [ ] CSV UTF-8 가져오기에서 헤더 매핑과 행별 오류를 반환한다.
- [ ] 고객·재무 목록을 CSV로 내보내고 다운로드 경로를 사용자에게 표시한다.
- [ ] 보고서 화면에서 고객 수, 열린 작업 수, 수입·지출 합계를 조회한다.
- [ ] 파일 크기·열 수·잘못된 날짜를 검증하고 테스트한다.

### Task 6: 계정·구독·팀·알림 기본 화면

**Files:**
- Create: `apps/desktop/src/business_assistant_desktop/account_page.py`
- Create: `apps/desktop/src/business_assistant_desktop/team_page.py`
- Create: `apps/desktop/src/business_assistant_desktop/notification_page.py`
- Modify: `apps/server/src/business_assistant_server/api/organizations.py`
- Test: `apps/desktop/tests/test_account_page.py`, `test_team_page.py`, `test_notification_page.py`

- [ ] 현재 사용자·조직·플랜·기능 목록을 카드로 표시한다.
- [ ] 팀원 목록과 역할을 표시하고 초대/역할 변경 API를 연결한다.
- [ ] 알림 목록과 읽음 처리 기본 API를 연결한다.
- [ ] owner/admin/member별 버튼 표시와 403 상태를 테스트한다.

### Task 7: 기본 자동화·연동 설정과 통합 검증

**Files:**
- Create: `apps/desktop/src/business_assistant_desktop/automation_page.py`
- Create: `apps/desktop/src/business_assistant_desktop/integration_page.py`
- Modify: `README.md`, `docs/03-menu-modules.md`, `docs/06-implementation-roadmap.md`
- Test: `apps/desktop/tests/test_navigation_integration.py`

- [ ] 조건·작업 한 개로 구성된 자동화 규칙을 등록·활성/비활성한다.
- [ ] 외부 서비스 연동은 provider·상태·설정 저장 UI만 제공한다.
- [ ] 모든 메뉴의 entitlement·조직 전환·오류 상태를 통합 테스트한다.
- [ ] `scripts/check.ps1` 실행 후 구현 상태 문서를 갱신하고 한글 커밋으로 push한다.
