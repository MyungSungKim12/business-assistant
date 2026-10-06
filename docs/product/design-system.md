# 데스크톱 디자인 기준

UI-001 · in-progress · 2026-09-30 · 담당 Codex

## 전체 리모델링 — 2026-09-29

- 사용자 재요청에 따라 UI-001 범위를 로그인·내비게이션·고객·시술·문서·업무·재무·파일 및 공통 팝업으로 확장한다. 선행 기능/API 계약과 입력 보호는 유지한다.
- 방향: 밝은 베이지 내비게이션, 아이보리 작업 배경, 따뜻한 흰색 패널, 로즈 브라운 선택 강조. 본문 Pretendard 14px, 보조 12~13px, 제목 26px. 고정 TTF를 사용한다.
- 참고 방식: Drop Point의 시스템 폰트·CSS 프레임워크를 직접 복제하지 않고, 자체 CSS 변수로 구성된 색상·패널·버튼·간격 원칙을 Qt Style Sheet와 제품 토큰으로 재구성한다. 한국어 선명도를 위해 앱 전용 Pretendard를 유지한다.
- 공통 컨트롤과 페이지별 스타일 중복을 줄이고 버튼 역할, 키보드 포커스, 비활성/오류 상태를 통일한다. 가짜 지표나 사용 불가능한 장식 버튼은 추가하지 않는다.
- 검증 예정: 기존 Qt 회귀, 1100/1440 너비 화면 렌더링, 125%/150% 배율, 한글 폰트 확인. 상용 출시·실환경 검증 완료와 구분한다.

### 구현 및 검증 — 2026-09-30

현재 기준은 이 항목이며 아래 초기 기준의 색상·폭·힌팅 설정을 대체한다.

- 작업 배경 `#F7F3ED`, 사이드바 `#E8DED2`, 카드 `#FFFDF9`, 본문 `#403A35`, 주요 강조 `#B98B68`을 사용한다. 전역 스타일은 `workspace_style.py`, 자산 경로 연결은 `design_tokens.py`에서 관리한다.
- 고객관리 전용 카드와 사진·활동 상세 영역도 같은 토큰을 직접 사용해 전역 스타일과 페이지 스타일이 서로 다른 색을 덮어쓰지 않게 한다.
- 시술관리의 진행 상태 바와 시작·완료·중단·정정 작업 버튼도 동일한 카드·로즈 브라운 체계로 표시한다. 상태 전환 의미와 권한은 기존 계약을 유지한다.
- 예약·할 일 화면의 오류 안내도 전용 인라인 색상 대신 공통 `#error` 상태 토큰을 사용해 메뉴 간 오류 표현을 통일한다.
- 내비게이션 204px, 기본 창 1440×920, 최소 창 1100×720. 선택/hover 구분과 선택 아이콘 대비, 권한 없는 메뉴의 비활성/툴팁, 스크롤바 숨김 및 휠·키보드 접근 유지. 매출·지출을 기본 메뉴에 포함한다.
- 고정 Pretendard 4종, 기본 14 논리 px. 전역 앱 글꼴은 Windows 아웃라인 렌더링과 `PreferFullHinting`을 사용하고 `PreferAntialias` 강제는 제거한다. Qt 배율 반올림은 `PassThrough`로 유지해 125/150%에서 글자 위치가 임의로 흔들리지 않게 한다. 실제 모니터의 ClearType/혼합 DPI 선명도 개선 여부는 사용자 확인 전 확정하지 않는다.
- 고객 카드 2/3열 반응형 배치, 검색창과 필터 분리, 프로필 폼 스크롤과 저장 버튼 고정. 창 크기를 변경해도 작성 중 입력과 선택 카드를 유지한다.
- 시술 상태 안내/작업 버튼 분리, 고객·이력·작성 패널 통일. 표 행 높이와 헤더 대비 개선. 문서·일정 작성 폼과 파일 작업을 패널로 묶고 매출 합계를 카드로 표현한다.
- 로그인, 상담, 서명·교부·철회, 문서 발행, 결제 초안, 서식 관리에 공통 간격·입력창·탭·버튼 역할 적용. 닫기와 주요 저장 작업의 강조를 분리하고 체크박스 SVG 표시를 명시한다.
- `QT_QPA_PLATFORM=offscreen; uv run --all-packages pytest apps/desktop/tests -q` → **170 passed**. 검색·저장 실패·재시도·읽기 전용·이탈 취소 등 기존 회귀 포함. 창 크기 변경 시 미저장 입력 보존 회귀 추가. 기존 테스트에서 독립 등록한 자식 페이지를 부모 창에 옮긴 뒤 정리할 때 발생한 중복 삭제를 테스트 소유권 정리로 수정했다.
- `.venv/Scripts/ruff.exe check apps/desktop scripts/preview-design.py scripts/preview-dialogs.py` 및 `format --check` → 통과. `git diff --check` 통과.
- 실제 Qt 위젯을 모의 자료로 실행해 1100×720/1440×920 및 고객 화면 배율 1/1.25/1.5를 렌더링했다. 운영 데이터·실계정·DB 변경 없이 검증했다. 서버 코드는 변경하지 않았다.
- `uv build --package business-assistant-desktop` 결과 wheel에 Pretendard 고정 글꼴 4종·라이선스·콤보 화살표·체크 아이콘·명시적 데모 사진이 포함되는 것을 확인했다. 자산 존재/비어 있지 않음 회귀 테스트를 추가했다.
- 증거: [고객](../screenshots/remodel-customers.png), [작은 고객 창](../screenshots/remodel-customers-compact.png), [125%](../screenshots/remodel-customers-125.png), [150%](../screenshots/remodel-customers-150.png), [시술](../screenshots/remodel-treatments.png), [문서](../screenshots/remodel-documents-1100.png), [매출](../screenshots/remodel-finance-1100.png), [일정](../screenshots/remodel-schedule-1100.png), [파일](../screenshots/remodel-files-1100.png), [로그인](../screenshots/remodel-login.png), [상담](../screenshots/remodel-consultation.png), [동의](../screenshots/remodel-document_consent.png), [결제 초안](../screenshots/remodel-sales_draft.png).
- 재현: `scripts/preview-customer.py`, `scripts/preview-treatments.py`, `scripts/preview-design.py`, `scripts/preview-dialogs.py`. 후자의 두 스크립트는 개발용 테스트 픽스처를 사용하며 배포 앱 기능이 아니다.
- 남은 인수: 사용자 Windows 모니터/혼합 DPI와 패키징 확인, 장문·대량 자료에 대한 전체 팝업 크기 인수, 사용자 디자인 확인. 미구현 메뉴는 안내 화면을 유지한다. UI-001 전체 상품화 인수는 in-progress를 유지한다. 커밋/배포 없음.

사용자 요청: 기존 고객·시술·문서·재무 기능을 유지하면서 상품화를 위한 화면 완성도를 높인다. 공통 UI 개선을 메뉴 기능과 구분해 추적하기 위해 UI-001을 추가했다. 선행 의존성은 기존 데스크톱 화면 및 Q-04/Q-12 품질 게이트다.

## 적용 원칙

- 밝은 베이지·아이보리 색을 기본으로 사용한다. 로즈 브라운은 선택·주요 저장·로그인, 일반 작업은 따뜻한 흰색 버튼으로 표현한다.
- Pretendard v1.3.9 고정 TTF 4종(Regular/Medium/SemiBold/Bold)을 앱에 포함한다. 사용자 글꼴 거칠음 제보 이후 가변 글꼴 사용을 중지하고 명시적 힌팅·안티앨리어싱을 적용했다. OS에 설치하지 않고 Qt에 앱 전용 등록한다. 원본과 OFL 라이선스는 assets에 동봉한다. 출처: https://github.com/orioncactus/pretendard/tree/v1.3.9
- 본문 14px, 보조 문구 12~13px, 화면 제목 24~25px, 카드 이름 15px로 정보 위계를 구분한다. 표 머리글, 탭, 팝업 선택 목록, 비활성 상태와 툴팁을 공통 스타일로 제공한다.
- 내비게이션 폭 188px. 선택/마우스 오버를 분리하고 Windows의 텍스트 포커스 사각형을 delegate에서 제거한다. 방향키 이동과 선택 배경은 유지한다. 스크롤바는 숨기되 목록의 휠/키보드 접근은 유지한다.
- 콤보박스의 펼침 화살표를 SVG로 제공한다. 화면별 구식 스타일이 전역 스타일을 덮어쓰던 부분을 정리한다.
- 사진 없는 실제 고객 카드는 빈 사진 세 칸 대신 연락처와 실제 고객 정보를 표시한다. 데모 사진은 기존 명시적 데모 경로에서만 사용한다.
- 고객관리의 3열 구조, 시술관리의 고객/이력/작성 3영역, 저장과 미저장 입력 보호 및 API 계약을 유지한다.

## 검증 및 남은 범위

초기 로컬 Qt 회귀 163개, Ruff 통과. 후속 고객 상세 개선에서 4종 굵기의 실제 해석/한글 글리프 검증을 추가했다. Qt offscreen의 QT_SCALE_FACTOR=1/1.25/1.5로 고객 화면을 확인했다. 이는 실제 Windows 모니터별 ClearType·DPI 설정 검증과 구분한다. 실제 계정 자료는 사용하지 않았다.

- [고객관리](../screenshots/customer-polished.png)
- [시술관리](../screenshots/treatments-polished.png)
- [고객 상세 후속 · 100%](../screenshots/customer-detail-1.png)
- [고객 상세 후속 · 150% 시뮬레이션](../screenshots/customer-detail-1.5.png)

후속 개선: 카드 간격·날짜 잘림 해결, 과다 태그를 +개수와 원문 툴팁으로 표시, 검색 초기화 아이콘, 상담 이력 읽기 영역, 상세 입력 크기 및 작은 글자 대비 개선. 사용자 모니터에서 글꼴이 깨져 보이는 정확한 원인은 미확정이며 재실행 후 확인이 필요하다. UI-001은 in-progress 유지한다.

후속 검증 명령: `QT_QPA_PLATFORM=offscreen` 환경에서 `uv run --all-packages pytest apps/desktop/tests -q` → 166 passed. `.venv/Scripts/ruff.exe check apps/desktop`, `format --check apps/desktop` → 통과. 4개 고정 굵기 모두 실제 weight 및 한글 지원 확인. 운영 DB 변경 없음.

이번 작업은 공통 시각 체계와 고객/시술 화면의 구체적 개선이다. 모든 메뉴의 업무 구조 재설계, 실제 사용자 사용성 검증, Windows 배율별 125/150% 및 패키지 배포 검증은 남아 있으므로 전체 상품화 완료로 표시하지 않는다. 좁은 시술 이력 표는 긴 이름을 생략 표시하며 원문은 기록 선택으로 확인한다. 운영 DB 변경/배포/커밋 없음.
