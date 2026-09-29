# 고객관리 1차 상품화 실행 계획

> For agentic workers: use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to execute each task and verify evidence before updating status.

**Goal:** 고객 프로필을 누락 없이 저장하고 고객별 상담 이력을 실제 API에 연결하며, 보관·복원 및 미저장 입력 보호를 제공한다.

**Architecture:** 기존 PySide6 화면 배치를 유지한다. 고객의 단일 데이터 모델은 `api_client.Customer`를 사용한다. HTTP 인증/직렬화는 ApiClient, 세션 결합은 MainWindow adapter, 화면 상태는 CustomerPage, 활동 이력 UI는 별도 CustomerActivityPanel이 담당한다. 기존 FastAPI 고객 및 활동 API를 사용하며 DB 변경은 하지 않는다.

**Tech Stack:** Python 3.13, PySide6, httpx, pytest-qt, Ruff, mypy.

**Spec:** [제품 계획 인덱스](../../product/README.md), [고객관리](../../product/menus/02-customers.md).

## 승인된 범위와 제약

- 사용자가 전체 메뉴 구성의 상세 문서 작성과 고객관리부터 실제 작업 진행을 요청했다.
- 현재 작업 트리의 이전 디자인 변경은 보존한다. 별도 초기화·자동 커밋·배포를 하지 않는다.
- 3열 카드 / 하단 프로필 / 우측 상세 구조를 유지한다.
- 고객 프로필: name, email, phone, notes, tags, status, birth_date, skin_type, concerns, allergies, last_visit_date, next_visit_date.
- 새 고객은 위 필드를 한 번의 POST에 담는다. 생성 후 보충 PATCH로 부분 저장하지 않는다.
- 보관은 status=archived, 복원은 status=active PATCH이며 DELETE는 화면에서 호출하지 않는다.
- 실제 고객에게 샘플 사진을 표시하지 않는다. 독립 데모 실행 시에만 명시적으로 허용한다.
- 조직 권한은 서버에서 계속 검증한다. UI에서도 owner/admin 외에는 수정 동작을 제공하지 않는다.
- 회원권/예약 통합, 사진 업로드 및 영속 저장, 담당자/유입 경로, 고객 병합, 약속 구조화는 후속 범위이다.

## Task 1 — 전체 프로필과 이력 API 연결

**Files:** `apps/desktop/src/business_assistant_desktop/api_client.py`, `apps/desktop/tests/test_api_client_customers.py`.

**Interfaces:** `create_customer_record(org, session, values) -> Customer`; `list_customer_activities(org, session, customer_id) -> list[CustomerActivity]`; `create_customer_activity(org, session, customer_id, values) -> CustomerActivity`.

- [x] 전체 필드 POST, 배열 보존, 빈 allergies 문자열, 인증 헤더, 활동 경로 및 오류 응답 테스트 작성/실패 확인.
- [x] Customer 필드 기본값과 CustomerActivity 모델 정의, 기존 parser 패턴으로 구현.
- [x] 관련 HTTP mock 테스트 통과. 서버 API 변경 없이 strict request 모델에 적합한 payload 확인.

## Task 2 — 고객 프로필 작업 완결성

**Files:** `customer_page.py`, `main_window.py`, `tests/test_customer_page.py`.

- [x] 기존 fake client를 실제 모델과 전체 프로필 create 계약으로 변경.
- [x] 태그/고민/날짜/공란을 포함한 생성·수정 round-trip 테스트 작성 및 실패 확인.
- [x] 숫자만 입력해도 하이픈이 있는 전화번호를 검색하고 전체/활성/보관 수를 표시.
- [x] 입력 검증(name/email/date), 실패 시 폼 유지, 저장 성공 후 선택 유지.
- [x] 보관/복원 PATCH 및 실패 시 상태 유지, 읽기 전용 사용자 쓰기 차단.
- [x] 고객 전환/새 고객/메뉴 이동/창 닫기 때 Save/Discard/Cancel로 미저장 입력 보호.
- [x] 운영 사진 없음과 명시적 데모 샘플을 분리. 원본 사진 없는 상태를 실제 이력처럼 표시하지 않음.

## Task 3 — 고객별 상담 이력

**Files:** `customer_activity_panel.py`, `tests/test_customer_activity_panel.py`, `main_window.py`, `customer_page.py`.

- [x] 실제 activity 리스트로 시간순 표시, 제목·설명·기록 종류 입력 후 서버 저장.
- [x] 고객 변경 시 다른 고객 이력이 남지 않는지 검증.
- [x] 로딩/비어 있음/실패·재시도 상태 제공, 실패 시 입력 보존.
- [x] 네트워크 조회/저장은 Qt worker에서 처리하고 결과는 메인 스레드에 반영.
- [x] 조회 중 고객 변경 시 오래된 요청 결과 무시, 저장 중 중복 클릭 차단.
- [x] 새로운 상담은 note, 시술 메모는 treatment이며 정식 시술/매출/재고 연동으로 오인하지 않도록 표시.

## Task 4 — 검증과 상태 갱신

- [x] Ruff check/format 및 mypy 통과.
- [x] 데스크톱 테스트와 서버/common 테스트를 분리 실행하고 결과 기록.
- [x] 1280×800 및 1100×720 캡처를 확인하고 잘림/빈 상태/선택/폼을 점검.
- [x] API/화면 경계 자체 검토 및 회귀 결과 반영, docs/product의 해당 기능만 verified로 갱신.
- [x] README에 제품 문서 링크, changelog에 이번 변경과 남은 단계/실제 서버 검증 한계를 기록.

## 검증 명령

```powershell
.venv/Scripts/python.exe -m ruff check .
.venv/Scripts/python.exe -m ruff format --check .
.venv/Scripts/python.exe -m mypy apps/server/src apps/desktop/src packages/common/src
$env:QT_QPA_PLATFORM='offscreen'
.venv/Scripts/python.exe -m pytest apps/desktop/tests -q
.venv/Scripts/python.exe -m pytest apps/server/tests packages -q
.venv/Scripts/python.exe scripts/preview-customer.py
```

## 현 상태

2026-09-18: 정의한 1차 로컬 작업 완료. desktop 91 / server-common 108 테스트, Ruff, mypy 통과. 25개 제품 문서/122개 기능 ID와 두 해상도 화면 확인. 별도 리뷰 작업은 실행 한도로 종료되어 통합 검토와 회귀 검증을 주 작업에서 수행했다. 실배포 서버/데이터 검증, 프로필 HTTP 비동기화, 생성 멱등 키는 후속 과제로 제품 문서에 기록했다.
