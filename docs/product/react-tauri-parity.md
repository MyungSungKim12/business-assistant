# React/Tauri 기능 동등성

UI-002 · in-progress · 2026-10-13

| 업무 | React/Tauri 상태 | 검증 | PySide6 유지 여부 |
| --- | --- | --- | --- |
| 로그인·조직·권한 | 구현 | React 집중 테스트 | 유지 |
| 고객 목록·프로필 | 구현 | React 집중 테스트 | 유지 |
| 고객 활동 | 구현 | React 집중 테스트 | 유지 |
| 고객 사진 | 구현 | React 집중 테스트, Rust 도구 체인 대기 | 유지 |
| 대시보드 고객·할 일 | 구현 | React 집중 테스트 | 유지 |
| 예약·달력·시술·문서·매출·ERP | 미전환 | 해당 없음 | 사용 |

Rust/Cargo가 이 PC에 없어 Native 패키지 빌드와 Windows 설치 인수는 `pending-rust-toolchain`이다. 따라서 UI-002는 verified가 아니며 PySide6 삭제 조건도 충족하지 않았다.
