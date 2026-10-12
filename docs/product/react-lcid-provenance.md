# React UI 참고 출처와 배포 확인

기준일: 2026-10-12. UI-002 React/Tauri 전환에서 `D:\LCID`를 참고한 범위와 배포 조건을 추적한다. 이 문서는 LCID 자체의 권리를 새로 부여하지 않는다.

| 참고 대상 | 적용 방식 | 현재 판정 |
| --- | --- | --- |
| `D:\LCID\packages\ui\src\base.css` | 조밀한 간격과 컨트롤 상태를 참고하고 베이지 토큰으로 새로 작성 | 재작성 |
| `D:\LCID\packages\ui\src\DataGrid.tsx` | 정렬·키보드·복사·열 너비 동작을 요구사항으로 사용 | Task 4에서 새로 작성 |
| `D:\LCID\packages\ui\src\Modal.tsx`, `Hosts.tsx` | 포커스·알림·확인 흐름을 요구사항으로 사용 | Task 3에서 새로 작성 |
| `D:\LCID\CLIENT\src\features\main\TopBar.tsx` | 상단 메뉴 정보 구조를 제품 메뉴에 맞게 재구성 | Task 7에서 새로 작성 |
| `D:\LCID\CLIENT\src\platform` | 브라우저/Tauri 경계와 OS 자격 증명 개념을 참고 | Task 5~6에서 새로 작성 |
| LCID 루트 | 별도 `LICENSE`, `COPYING`, `NOTICE` 파일을 찾지 못함 | 소스 직접 복사 금지, 동작만 참고 |

## 외부 패키지

| 패키지 | 기준 버전 | 라이선스 확인 위치 |
| --- | --- | --- |
| React / React DOM | `^19.3.0` | 설치 패키지 `package.json` |
| TanStack Query | `^5.104.1` | 설치 패키지 `package.json` |
| Zustand | `^5.0.15` | 설치 패키지 `package.json` |
| Vite / Vitest | `^8.3.4` / `^5.0.3` | 설치 패키지 `package.json` |
| Tauri | 2.x | JavaScript/Rust 설치 패키지 메타데이터 |

배포 전에 잠금 파일 기준의 전체 라이선스 목록을 생성하고 금지 조건이 없는지 다시 확인한다.

## 글꼴

SUIT 고정 TTF 400·500·600·700과 `SUIT-LICENSE.txt`는 기존 PySide6 앱에 포함된 동일 자산을 복사한다. 원본은 SUIT 프로젝트이며 SIL Open Font License 조건에 따라 라이선스 파일을 설치물에 함께 포함한다.
