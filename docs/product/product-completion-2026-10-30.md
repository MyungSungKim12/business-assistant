# 2026-10-30 후속 제품 작업 1~12

사용자 승인: 12개 항목을 순차 구현하고 필요한 SQL은 작성·검증 후 Supabase에 직접 적용한다. 중간 완료 응답으로 작업을 끊지 않는다. 외부 공급자/배포 환경 연결·실환경 인수와 코드 구현을 구분한다. 기존 미커밋 변경을 보존하고 요청 없이 커밋·푸시·공개 배포·실제 고객 발송을 하지 않는다.

기준: SQL 100은 원격 적용 완료. 앞선 R1030-01~08 코드 보완과 이번 N1030-01~12 제품 확장을 구분한다. 설계는 [후속 제품 설계](../superpowers/specs/2026-10-30-product-completion.md), 실행 세부는 [구현 ledger](../superpowers/plans/2026-10-30-product-completion.md)에서 관리한다.

2026-11-03 최종 기록: 1~12번의 현재 표 범위 상태 및 SQL 066~112 원격 이력을 대조했다. 변경분은 API/화면/DB/Android/운영 스크립트/문서 단위 8개 한글 커밋으로 `main`에 푸시됐다. 마지막 집중 검증은 API 466 tests, 화면 851 tests, API/React production build 통과다. 전체 제품 회귀·실기기·운영 배포·복구 인수는 미실시이며 [잔여 작업표](current-remaining-work-2026-11-03.md)에 남긴다. 아래 11/02 재개 문구는 그 시점의 상태 기록으로 보존한다.

2026-11-02 재개 확인: 이전 보조 작업은 실행 중이지 않았으며 1번 변경만 작업 트리에 남아 있었다. 101번은 원격 미적용이고 2~12번은 미착수임을 확인했다. 1번의 보관 고객 첫 페이지 문제·고객 전환 초안 경계·매출 고객명 재시도를 수정·집중 검증하고 독립 재검토 후 순차 진행한다.

| 순서 | ID / 기존 기능 | 상태 | 결과·증거 / 잔여 |
| --- | --- | --- | --- |
| 1 | N1030-01 / CRM·DASH 조회 성능 | verified (code/SQL) | 11/02 API29·PC99 tests/타입·PC 빌드·격리 SQL 통과. SQL101 원격 적용/권한·고객19명 유지 확인. 실제 앱 인수 별도 |
| 2 | N1030-02 / SET-001 예약 정책 | verified (code/SQL) | 11/02 API120·React70 tests/타입·빌드·격리 SQL·기존 예약 경로 통과. SQL102 원격 적용·테이블/RLS/익명 차단·예약23건 유지 확인. DST 전환 구간 보수적 거절 한계·실앱 인수 별도 |
| 3 | N1030-03 / SET-003 계정 복구·세션 | verified (범위 한정) | 11/02 API14·React29 tests/빌드·타입/격리 SQL·독립 보안 재검토 통과. SQL103 원격 적용, 메일 주소 열거 차단 확인. SMTP 실발송/실계정·앱 인수와 초대/퇴사 흐름 별도 |
| 4 | N1030-04 / INT-007 전화 수신함 | verified (코드/SQL 한정) | 11/02 API23·React24·Kotlin10·build/typecheck·격리 SQL·독립 검토 통과. SQL104 원격 적용/ACL·고객19·예약23 유지 확인. 실전화/JWT/다중 프로세스/scheduler 인수 별도. [감사](audits/2026-11-02-durable-phone-inbox.md) |
| 5 | N1030-05 / INT-006 번호부 증분 | verified (코드/SQL 한정) | 11/02 API25·Kotlin21·PGlite/native PostgreSQL 동시 연결·빌드·독립 검토 통과. SQL105 원격 적용·고객19/예약23 유지·직접 권한 차단 확인. 실기기·scheduler 인수 별도. [감사](audits/2026-11-02-phone-directory-incremental.md) |
| 6 | N1030-06 / MED-002 사진 자동 정리 | verified (bounded) | 11/03 SQL106 원격 적용 + 5분 cron 첫 실행 `succeeded`; API/React/격리 PostgreSQL·독립 리뷰. pending/failed 데이터가 없어 실 복구·재선택은 미인수. [감사](audits/2026-11-02-photo-upload-maintenance.md) |
| 7 | N1030-07 / SET-002 업무별 권한 | verified (범위 한정) | API/구성원 권한 UI·격리 SQL 검증, SQL107 `20261102072810` 및 SQL108 `20261103000000` 원격 적용. owner-only 저장·member 쓰기 권한 상한·감사·RPC-only 테이블 확인. 메뉴별 선제 버튼 숨김 확대와 실계정 인수는 잔여. [감사](audits/2026-11-03-business-permissions.md) |
| 8 | N1030-08 / MKT 고객 메시지 | verified (bounded code/SQL) | MKT-001~003 템플릿·대상 미리보기·동의 재검사·멱등 대기열·취소/제한 재시도. SQL109 원격 적용. SMS/알림톡 provider·worker·webhook·MKT-004~007은 미완료 |
| 9 | N1030-09 / APT 복수 시술 예약 | verified (bounded code/SQL) | APT-021: 2~8개 시술을 담당자·공간/장비별 시간 구간으로 원자 저장·수정·취소·상태 변경. SQL110 원격 적용, 기존 예약 23건·고객 19명 유지. 실제 앱 동선 인수는 별도 |
| 10 | N1030-10 / INV 입력 편의 | verified (bounded code) | 바코드 스캔을 상품 입고·실사 입력에 연결하고 안전재고 부족 보충 수량을 매입 단위로 제안. 기존 원장/FEFO/단위 환산 사용, 실제 발주 자동 생성 안 함 |
| 11 | N1030-11 / DOC 모바일 서명 | verified (bounded) | SQL111/112·모바일 서명 링크·토큰/증빙·역할 검증; HTTPS/기기 인수 잔여 |
| 12 | N1030-12 / OPS 배포 준비 | verified (bounded docs/code audit) | HTTPS API 주소·업데이트 서명 계약·세션/번호부 철회 범위·진단/복구 runbook 정리; 실제 배포/복구/기기 인수는 외부 잔여 |

검증 결과는 기능별 audit에 기록한다. `verified`는 검증된 세부 코드/SQL 범위에만 적용하며 실제 공급자 발송·서버 공개 배포·휴대폰/Windows 운영 인수가 없으면 완료로 표시하지 않는다.

2026-11-02 1~3번 검증/적용 완료: [고객 조회 성능](audits/2026-11-02-customer-query-performance.md), [매장 예약 정책](audits/2026-11-02-organization-booking-policies.md), [계정 복구·세션](audits/2026-11-02-account-recovery-sessions.md). SQL101 `20261102004544`, SQL102 `20261102005828`, SQL103 `20261102055227` 원격 적용. 각 검증 범위 한정이며 실제 앱·외부 메일 인수는 별도다. 다음은 N1030-04 전화 수신함이다.

2026-11-03 Task7 업무 권한 범위 검증: 격리 SQL 체크 통과, API24/PC28 focused tests, API·PC build 통과. SQL107/108 원격 적용과 권한 테이블의 RLS·직접 ACL 차단을 확인했다. 화면별 모든 동작의 사전 숨김 및 실계정별 통합 인수는 미완료 범위로 남긴다. [감사](audits/2026-11-03-business-permissions.md).
