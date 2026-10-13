# React/Tauri 기능 동등성

UI-002 · in-progress · 2026-10-13

| 업무 | React/Tauri 상태 | 검증 | 기존 PySide6 클라이언트 |
| --- | --- | --- | --- |
| 로그인·조직·권한 | Node API 전환 구현 | Fastify 단위·흐름 테스트 | 제거 |
| 고객 목록·프로필 | Node API 전환 구현 | Fastify 단위·흐름 테스트 | 제거 |
| 고객 활동 | Node API 전환 구현 | Fastify 단위·흐름 테스트 | 제거 |
| 고객 사진 | 구현 | React 집중 테스트, Rust 도구 체인 대기 | 제거 |
| 대시보드 고객·할 일 | 구현 | 최종 회귀 대기 | 제거 |
| 할 일 등록·상태·삭제 | Node API/React 전환 구현 | 최종 회귀 대기 | 제거 |
| 예약 목록·생성·상태 전이 | Node API/React 전환 구현 | 최종 회귀 대기 | 제거 |
| 시술·매출·회원권·재고·직원·정산·문서·파일 | 조직/기능 권한을 적용한 실제 데이터 조회 화면 구현 | 최종 회귀 및 실환경 인수 대기 | 제거 |
| 각 운영 메뉴의 생성·정정·승인 업무 | 미전환 | 해당 없음 | 제거 |

2026-10-13에 기존 PySide6 클라이언트를 제거하고 React/Tauri를 기본 데스크톱으로 전환했다. 미전환 업무는 기존 앱으로 우회하지 않으며, 전환 순서에 따라 React 기능으로 구현한다.

Rust/Cargo가 이 PC에 없어 Native 패키지 빌드와 Windows 설치 인수는 `pending-rust-toolchain`이다. 따라서 UI-002는 verified가 아니며 Windows 설치 검증이 남아 있다.

2026-10-13 UI 밀도 개선에서는 LCID의 정보 밀도와 Windows 업무 앱 구조를 참고해 38px 상단 메뉴, 28px 테이블 행, 26px 입력·버튼, 12px 본문, 작은 모서리 반경으로 공통 규격을 다시 구성했다. 밝은 베이지 색상은 Business Assistant 고유 토큰으로 유지했다. Native 실행을 기본 경로로 문서화했고 웹 실행은 UI 미리보기로 분리했다.

2026-10-13 후속 전환에서는 예약 RPC, 담당자·서비스 조회, 할 일 CRUD와 8개 운영 메뉴의 실제 Supabase 조회를 Node API에 연결했다. 읽기 화면 존재를 업무 완료로 표시하지 않으며, 시술·결제·회원권·재고·문서·파일의 쓰기 동선은 계속 `in-progress`로 추적한다.

2026-10-13 최종 회귀: `pnpm react:test -- --run`에서 React UI 15개와 데스크톱 React 26개, Node API 23개를 통과했다. `pnpm react:build`와 `pnpm api:build`도 통과했다. 실제 Supabase 왕복, 고객 사진 Storage 및 Windows Native 설치 인수는 실행하지 않았다.
