# React/Tauri 기능 동등성

UI-002 · in-progress · 2026-10-13

| 업무 | React/Tauri 상태 | 검증 | 기존 Python(PySide6·FastAPI) |
| --- | --- | --- | --- |
| 로그인·회원가입·조직 생성·선택·권한 | 구현 | vitest(API·화면) | 제거 |
| 고객 목록·프로필·활동·사진 | 구현 | vitest | 제거 |
| 대시보드·할 일 | 구현 | vitest | 제거 |
| 예약(목록·생성·상태 전이·공간·장비 자원·담당자 근무·휴무) | 구현 | vitest | 제거 |
| 시술·상담·변경 이력·시술 판매 초안 | 구현 | vitest, 실 DB 시술 이력 조회 화면 확인 | 제거 |
| 매출 장바구니·할인·복합 수납·환불·상품 반품·일 마감 | 구현 | vitest | 제거 |
| 재무(수입·지출·요약)·경영 미리보기 | 구현 | vitest | 제거 |
| 상품·재고·회원권(지갑)·서비스·직원 | 구현 | vitest | 제거 |
| 문서·서식 버전·동의서 서명·시술 문서 발행·파일 자료 | 구현 | vitest, Rust 단위 테스트(파일 선택·형식) | 제거 |
| 플랫폼 관리자 구독 교체 | 구현(API·화면) | vitest | 제거 |
| DB 마이그레이션 계약 검사 | Node(vitest) 이식 | 29개 | 제거 |

2026-10-13에 기존 PySide6 클라이언트를 제거하고 React/Tauri를 기본 데스크톱으로 전환했다. 미전환 업무는 기존 앱으로 우회하지 않으며, 전환 순서에 따라 React 기능으로 구현한다.

Rust/Cargo가 이 PC에 없어 Native 패키지 빌드와 Windows 설치 인수는 `pending-rust-toolchain`이다. 따라서 UI-002는 verified가 아니며 Windows 설치 검증이 남아 있다.

2026-10-13 UI 밀도 개선에서는 LCID의 정보 밀도와 Windows 업무 앱 구조를 참고해 38px 상단 메뉴, 28px 테이블 행, 26px 입력·버튼, 12px 본문, 작은 모서리 반경으로 공통 규격을 다시 구성했다. 밝은 베이지 색상은 Business Assistant 고유 토큰으로 유지했다. Native 실행을 기본 경로로 문서화했고 웹 실행은 UI 미리보기로 분리했다.

2026-10-13 후속 전환에서는 예약 RPC, 담당자·서비스 조회, 할 일 CRUD와 8개 운영 메뉴의 실제 Supabase 조회를 Node API에 연결했다. 읽기 화면 존재를 업무 완료로 표시하지 않으며, 시술·결제·회원권·재고·문서·파일의 쓰기 동선은 계속 `in-progress`로 추적한다.

2026-10-13 최종 회귀: `pnpm react:test -- --run`에서 React UI 15개와 데스크톱 React 26개, Node API 23개를 통과했다. `pnpm react:build`와 `pnpm api:build`도 통과했다. 실제 Supabase 왕복, 고객 사진 Storage 및 Windows Native 설치 인수는 실행하지 않았다.

2026-10-13 전환 완료: 남아 있던 Python 서버(apps/server)의 라우트 102개를 Node API(apps/api/src/modules/*)로 옮기고 React 화면을 연결했다. 모든 Python 라우트가 Node에 존재하는지 프로브로 확인했고(누락 4건은 조직 생성·회원가입·고객 삭제·빈 경로 라우트로, 앞의 세 가지를 추가했으며 나머지는 기존 라우트와 동일), 이후 Python 서버·공통 패키지·uv 설정을 삭제했다.

검증: API 543개, 공통 UI 15개, 데스크톱 React 253개 vitest와 Rust 11개 단위 테스트를 통과했다. 실제 Supabase로는 시술 이력 조회만 앱 화면에서 확인했다. 매출 화면은 실 DB에서 일부 자료를 불러오지 못했는데, 시드 마이그레이션(002)에 `finance.basic` 기능이 없어 구독 플랜이 해당 기능을 갖지 못했을 가능성이 있었다(서버가 `crm.basic`+`finance.basic`을 요구). `039_finance_basic_feature.sql`이 이 키를 모든 요금제에 추가한다. 운영 DB에 적용한 뒤 매출·재고·정산 화면을 다시 확인해야 한다.
