# 베이지 톤 전체 UI 리모델링 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 기존 업무 기능과 화면 구조를 유지하면서 전체 데스크톱 앱을 밝은 베이지·아이보리 톤의 카드 중심 UI로 통일한다.

**Architecture:** 공통 색상·간격·상태 토큰을 `design_tokens.py`에 두고, 전역 Qt 스타일을 `workspace_style.py`에서 소비한다. 메뉴별 화면은 공통 카드·버튼·입력 스타일만 사용하도록 조정하며 API와 저장 계약은 건드리지 않는다.

**Tech Stack:** Python 3.13, PySide6/Qt Widgets, pytest, Ruff, Pretendard TTF assets.

**Spec:** `docs/superpowers/specs/2026-10-01-beige-ui-redesign-design.md`

## Global Constraints

- 전체 작업 배경은 `#F7F3ED`, 사이드바는 `#E8DED2`, 카드 표면은 `#FFFDF9`를 사용한다.
- 기본 글자는 `#403A35`, 보조 글자는 `#8D8378`, 주요 강조는 `#B98B68`로 제한한다.
- 기존 API 계약, Supabase 저장 구조, 권한 검사는 변경하지 않는다.
- 실제 데이터가 없는 화면에 가짜 지표나 장식용 상태를 추가하지 않는다.
- 사용자 Windows 환경에서 확인하기 전에는 상품화 완료로 표시하지 않는다.

## Review Focus

- 1100px 창에서 사이드바와 본문이 겹치지 않고 핵심 버튼이 보이는지 — `test_main_window.py`의 창 최소 크기·내비게이션 회귀 테스트
- 125%·150% 배율에서 한글 글자와 입력창이 잘리지 않는지 — `test_product_font.py`와 offscreen 배율 렌더링
- 선택·hover·focus 상태가 서로 혼동되지 않는지 — `test_ui_components.py`의 공통 스타일 토큰 검사
- 오류·빈 상태·읽기 전용 화면이 베이지 배경에서도 충분한 대비를 가지는지 — 각 대표 페이지 테스트의 상태 렌더링 검사
- 기존 저장·취소·메뉴 전환 동선이 스타일 변경으로 깨지지 않는지 — 전체 데스크톱 회귀 테스트

### Task 1: 공통 베이지 디자인 토큰과 전역 스타일

**Files:**
- Modify: `apps/desktop/src/business_assistant_desktop/design_tokens.py`
- Modify: `apps/desktop/src/business_assistant_desktop/workspace_style.py`
- Test: `apps/desktop/tests/test_design_tokens.py`, `apps/desktop/tests/test_ui_components.py`

**Interfaces:**
- Consumes: 기존 `application_stylesheet()`와 위젯 objectName/role 선택자
- Produces: `COLORS`의 베이지 토큰과 모든 공통 위젯에 적용되는 `WORKSPACE_STYLE`

- [ ] **Step 1: 베이지 토큰 테스트를 추가한다** — `COLORS["canvas"]`, `surface`, `nav`, `text`, `primary`, `border`가 설계 문서의 정확한 값인지 검사한다.
- [ ] **Step 2: 공통 스타일의 색상·상태 선택자 테스트를 추가한다** — 사이드바, 선택 메뉴, 카드, 버튼, 입력, 테이블, 탭, tooltip이 네이비 값을 재사용하지 않고 베이지 토큰을 포함하는지 검사한다.
- [ ] **Step 3: `design_tokens.py`와 `workspace_style.py`를 수정한다** — 설계 문서의 색상·모서리·간격·hover/focus/disabled 상태를 적용하고 체크 아이콘·콤보 화살표 자산 연결은 유지한다.
- [ ] **Step 4: 공통 테스트를 실행한다** — `QT_QPA_PLATFORM=offscreen; uv run --all-packages pytest apps/desktop/tests/test_design_tokens.py apps/desktop/tests/test_ui_components.py -q`가 통과해야 한다.

### Task 2: 사이드바와 앱 셸 전환

**Files:**
- Modify: `apps/desktop/src/business_assistant_desktop/main_window.py`
- Modify: `apps/desktop/src/business_assistant_desktop/app.py` if application-level palette setup requires it
- Test: `apps/desktop/tests/test_main_window.py`

**Interfaces:**
- Consumes: Task 1의 `COLORS`와 `WORKSPACE_STYLE`
- Produces: 고정 베이지 사이드바, 웜 브라운 선택 상태, 기존 메뉴 키·권한·키보드 이동 동작

- [ ] **Step 1: 앱 셸 회귀 테스트를 먼저 작성한다** — 메뉴 전환, 전체 메뉴 토글, disabled 메뉴, 스크롤바 숨김, 1100px 최소 창을 기존 동작과 함께 고정한다.
- [ ] **Step 2: `main_window.py`의 셸 색상 의존성을 토큰 기반으로 정리한다** — 사이드바 폭과 objectName은 유지하고 브랜드·메뉴·footer의 색상과 여백만 베이지 기준으로 맞춘다.
- [ ] **Step 3: 포커스 사각형과 선택 테두리를 정리한다** — 선택 메뉴는 옅은 배경과 좌측 포인트를 사용하고 hover와 selected 상태를 분리한다.
- [ ] **Step 4: 셸 테스트를 실행한다** — `QT_QPA_PLATFORM=offscreen; uv run --all-packages pytest apps/desktop/tests/test_main_window.py -q`가 통과해야 한다.

### Task 3: 대시보드·고객관리 대표 화면 적용

**Files:**
- Modify: 해당 대시보드 페이지 파일과 `apps/desktop/src/business_assistant_desktop/customer_page.py`
- Modify: 공통 카드·요약 컴포넌트를 정의한 기존 파일만 필요한 범위에서 수정
- Test: 관련 `apps/desktop/tests/test_*page.py`와 `test_customer_page.py`

**Interfaces:**
- Consumes: Task 1~2의 카드·버튼·입력 스타일과 기존 고객/API 상태
- Produces: 실제 데이터 기반 요약 카드, 베이지 선택 고객 카드, 우측 상세 패널, 로딩·빈 상태·오류 표시

- [ ] **Step 1: 고객 선택·빈 상태·오류 회귀 테스트를 추가한다** — 선택 고객 유지, 작성 중 입력 보호, 사진 업로드 실패 재시도, 빈 사진 상태를 검증한다.
- [ ] **Step 2: 고객관리의 카드·상세·검색·필터 영역을 베이지 계층으로 정리한다** — API 호출과 데이터 모델은 변경하지 않는다.
- [ ] **Step 3: 대시보드에 실제 응답이 있는 요약만 카드로 배치한다** — 데이터가 없는 지표는 빈 상태로 표시하고 임의 숫자를 만들지 않는다.
- [ ] **Step 4: 대표 화면 테스트와 offscreen 렌더링을 실행한다** — 관련 page 테스트와 1100/1440px 렌더링이 통과해야 한다.

### Task 4: 예약·상담·시술·문서·파일·정산 화면 확장

**Files:**
- Modify: `schedule_page.py`, `consultation_dialog.py`, `treatment_page.py`, `document_page.py`, `file_page.py`, `finance_page.py` 및 해당 공통 위젯
- Test: 각 페이지의 기존 테스트

**Interfaces:**
- Consumes: Task 1의 공통 토큰·상태 스타일과 Task 2의 앱 셸
- Produces: 메뉴별 동일한 제목·설명·카드·상태 배지·오류/빈 상태 표현

- [ ] **Step 1: 각 메뉴의 주요 상태를 테스트 목록으로 고정한다** — 정상, 빈 상태, 실패, 취소, 읽기 전용, 권한 없음의 표시를 기존 API 계약에 맞춰 확인한다.
- [ ] **Step 2: 예약·상담·시술 화면을 카드와 상태 단계 중심으로 정리한다** — 업무 전환과 저장 동작은 유지한다.
- [ ] **Step 3: 문서·파일·정산 화면을 업로드/발행/확정 전후 상태가 구분되도록 정리한다** — 확정 전 초안과 확정 원장은 시각적으로 분리한다.
- [ ] **Step 4: 메뉴별 테스트를 실행한다** — 변경한 페이지 테스트가 모두 통과하고 실제 데이터 호출 없이 상태 픽스처로 검증된다.

### Task 5: 폰트·배율·시각 회귀와 문서 갱신

**Files:**
- Modify: `docs/product/design-system.md`
- Modify: `docs/product/roadmap.md`, `docs/product/changelog.md`
- Test/Artifacts: `apps/desktop/tests/test_product_font.py`, `docs/screenshots/`

**Interfaces:**
- Consumes: Task 1~4의 최종 UI
- Produces: 색상 기준과 검증 증거가 반영된 제품 문서

- [ ] **Step 1: Pretendard 굵기·한글 렌더링 테스트를 실행한다** — 4종 고정 글꼴과 100/125/150% 배율에서 잘림·겹침이 없는지 확인한다.
- [ ] **Step 2: 1100×720 및 1440×920 대표 화면을 렌더링한다** — 대시보드, 고객, 시술, 문서, 파일, 정산 화면의 스크린샷을 저장한다.
- [ ] **Step 3: 전체 회귀·Ruff·diff 검사를 실행한다** — `QT_QPA_PLATFORM=offscreen; uv run --all-packages pytest apps/desktop/tests -q`, Ruff check/format check, `git diff --check`를 실행한다.
- [ ] **Step 4: 디자인 기준과 변경 이력에 실제 결과와 남은 제한을 기록한다** — 실제 Windows 모니터 검증 전에는 UI-001을 `in-progress`로 유지한다.

