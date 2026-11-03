# Product Completion 1–12 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development task-by-task; 순차 구현·검토하며 사용자에게 중간 완료 보고를 하지 않는다. 커밋은 사용자 요청이 없으므로 생략한다.

**Goal:** 승인된 12개 후속 항목의 구현과 필요한 SQL 원격 적용을 끝내고 외부 연결/실환경 인수를 분리한다.
**Architecture:** 기존 기능 모듈·공통 API/RLS·React UI를 확장한다. 기능별 focused tests와 독립 리뷰를 거치며 기존 변경을 보존한다.
**Tech Stack:** React/Tauri, Fastify/TypeScript, Supabase/Postgres, Kotlin/WorkManager.
**Spec:** `docs/superpowers/specs/2026-10-30-product-completion.md`.

## Global Constraints

- 사용자 승인: 전체 항목 순차 구현 + 필요한 SQL 직접 적용. 전체 테스트/운영 인수·실발송·공개 배포·커밋/푸시는 제외.
- 현재 기본 작업 폴더를 유지한다. 기존 미커밋/미추적 코드를 다른 checkout으로 옮기거나 초기화하지 않는다.
- SQL 번호 100까지 원격 적용 완료. 새 번호는 파일/원격 이력을 확인해 결정하며 적용은 주 에이전트가 수행한다.
- 기존 기능 ID에 N1030-01~12 감사 추적 ID를 연결한다. 해당 기능만 in-progress로 바꾸고 검증된 세부 범위만 verified 표시한다.

## Review Focus

1. 검색 밖 선택 고객/이전 비동기 응답이 현재 초안을 덮지 않는지.
2. 매장 정책·권한·복수 시술 조건이 UI를 우회한 DB/API 호출에도 적용되는지.
3. 동일 이벤트·발송·서명 재시도가 중복 업무 기록을 만들지 않는지.
4. 로그아웃/동의 철회/다른 조직 요청에서 기기·메시지·공개 링크 데이터가 유출되지 않는지.
5. 미설정 외부 공급자·서버/서명키를 실제 성공으로 처리하지 않는지.

Ruling (2026-11-02, Task2): 서머타임 offset 전환을 가로지르는 점유 구간은 SQL/추천 모두 명시적으로 거절한다. 단순 현지 시작/종료 시각 비교가 되돌아간 시계의 닫힌 시간을 놓치는 문제를 독립 검토에서 재현했다. 배타적 종료 직전 offset을 사용해 전환 시각에 정확히 끝나는 예약은 보존한다. 한국 기본 시간대는 영향 없으며 정상 IANA 날짜는 지원한다. 이 선택의 한계는 DST 전환을 포함한 일부 실제 가능한 예약도 추천하지 않는 것이며, 완전한 모호 시각 지원은 후속 확장이다.

## Sequential ledger

| 순서/ID | 상태 | 소유 범위·인터페이스 | 검증/기록 |
| --- | --- | --- | --- |
| 1 N1030-01 | verified (code/SQL) | 고객 search/get 공통 소비, TreatmentPage/SalesPage, dashboard API+서버 집계 RPC | 선택/이탈/검색 경쟁·집계 경계·focus 테스트·SQL 후속 |
| 2 N1030-02 | verified (code/SQL; bounded) | 매장 예약 정책 DB/RPC/API/기존 예약·추천 화면 | API120·React70/타입·격리 SQL·반복 예약 경로 pass, SQL102 원격 version `20261102005828`; DST offset 전환 구간 보수 거절·실앱 인수 잔여 |
| 3 N1030-03 | verified (bounded) | auth gateway/routes, 로그인/설정 복구·기기 화면 | API14/React29, build/typecheck, isolated SQL, independent final security review pass; SQL103 version `20261102055227`; SMTP/실계정·앱 인수 잔여 |
| 4 N1030-04 | verified (bounded) | phone gateway/영속 relay routes·수신함·콜백 | API23/React24/Kotlin10/build/typecheck/isolated SQL and independent review pass; SQL104 version `20261102062807`; real device/JWT/process/scheduler acceptance remains |
| 5 N1030-05 | verified (bounded) | 고객 변경 로그/전화 directory cursor·Kotlin 병합 | API25/Kotlin21, PGlite+native PG 3-connection ordering, APK/build and independent review pass; SQL105 `20261102065323`; real S23/Keystore/WorkManager/cleanup scheduler remain |
| 6 N1030-06 | verified (bounded code/SQL/cron) | 사진 bounded maintenance scheduler + 원인/재등록 | SQL106 `20261102071744`; API/React/격리 PGlite+native PG/빌드/독립 review; 5분 cron actual `succeeded`. No pending/failed rows, so actual recovery/upload UI remains unverified; MED-002 broader in-progress |
| 7 N1030-07 | verified (bounded) | 조직 업무 권한·변경 감사·API/React 소비 | API24/PC28, API·PC build, isolated SQL pass; SQL107 `20261102072810` + SQL108 `20261103000000`; RPC-only ACL/RLS and role ceiling confirmed. Menu-level affordance coverage and live role-account acceptance remain |
| 8 N1030-08 | verified (bounded) | MKT-001~003 템플릿·대상 미리보기·동의 재검사·멱등 대기열·취소/제한 재시도; provider readiness는 항상 false | SQL109 원격 `20261103001028`; PGlite·API7·React1·API/React build pass. Provider/worker/webhook·MKT-004~007·운영 인수 잔여 |
| 9 N1030-09 | verified (bounded code/SQL) | APT-021 방문 내 복수 시술·구간별 담당자/자원·원자 저장/수정/상태 변경 | SQL110 `20261103004028`; 격리 SQL/API/React/build 통과; 기존 DB 건수 유지. 실앱 인수 잔여 |
| 10 N1030-10 | verified (bounded code) | INV-009 바코드 입고/실사 입력·안전재고 보충 발주 제안 | React70 tests/build, purchase-orders isolated DB pass. No new SQL; physical scanner acceptance pending |
| 11 N1030-11 | verified (bounded) | 문서 공개 링크·모바일 서명·직원 발급/철회 | SQL111/112·API/React·집중 DB 검증; HTTPS/실제 기기 인수 잔여 |
| 12 N1030-12 | verified (bounded docs/code audit) | 배포 환경/기기/서명/진단/복구 절차 | 주소·서명 검증·세션/번호부 해제·복구 절차 기록; 실제 배포·복구 dry-run은 외부 대기 |

## Each task

- [ ] 해당 소스/API/기존 기능 ID와 의존성 확인, 필요한 세부 설계를 해당 작업 기록에 추가.
- [ ] 실패 테스트와 원하는 계약을 먼저 작성·실행.
- [ ] 실제 동선의 화면/API/DB 연결을 구현, 정상·오류·취소·재시도·권한·조직 경계 검증.
- [ ] 독립 코드 검토, 중요한 발견 수정 후 필요한 집중 검증만 재실행.
- [ ] SQL은 격리 엔진 검증 후 원격 사전 점검·migration·사후 권한/건수 확인.
- [ ] docs/product 해당 기능·changelog·이 ledger 갱신 후 다음 항목 시작. 이 중간 단계에서 사용자에게 완료 응답으로 턴을 끝내지 않는다.

2026-11-02~03 Task1 done: independent P1/P2 review fixes + re-review clean, API29/PC99/SQL isolated/type/build pass. SQL101 applied `20261102004544`; invoker ACL/anonymous denial/customer count19 unchanged. Task2 done: API120/React70/isolated SQL/type/build and existing recurring reservation route pass; SQL102 applied `20261102005828`, organizations policy tables RPC-only, existing appointments23 unchanged. Task3 done within bounded scope: API14/React29/isolated SQL/build/type and independent final review pass; account-enumeration outage regression fixed; SQL103 applied `20261102055227`, customer/appointment data unchanged. Task4 done within bounded scope: API23/React24/Kotlin10/build/type/isolated SQL + independent security review pass; expiry replay and pending memo draft loss fixed; SQL104 applied `20261102062807`, direct inbox table ACL denied, customer/appointment rows unchanged. Task5 done within bounded scope: API25/Kotlin21, PGlite + native PostgreSQL commit-order, APK/build and independent review pass; organization-delete cascade regression and strict caller deadline fixed; SQL105 `20261102065323` applied, customer19/appointment23 unchanged and direct table ACL denied. Task6 bounded implementation and SQL106 `20261102071744` applied; first 5-minute cron run succeeded, real pending recovery not witnessed. Task7 bounded implementation verified: SQL107 `20261102072810` + SQL108 `20261103000000`; isolated SQL, API24/PC28, API·PC builds pass; RPC-only DB access confirmed. Remaining menu affordance coverage and live role-account acceptance are explicit follow-ups. Task8 MKT templates/outbox bounded implementation and SQL109 `20261103001028` applied; external provider/worker remains planned. Task9 APT-021 grouped multi-service appointments bounded implementation and SQL110 `20261103004028` applied; focused isolated SQL, API13, React87, API/React build pass; live app workflow remains pending. Next Task10 INV input convenience.



2026-11-03 Task9 N1030-09 APT-021 completed (bounded): SQL110 20261103004028 remotely applied after isolated PGlite/API13/React87/API+React build; remote kept customers19/appointments23, new groups0, RLS/direct ACL and RPC roles checked. Task10 N1030-10 INV-009 completed (bounded): barcode-to-inbound/stocktake paths, scanner count accumulation, low-stock purchase proposal by purchase-unit ceiling; no new SQL. React70 tests, purchase-orders isolated DB test and React build passed. Outstanding stocktake/scanner field acceptance and no outstanding-purchase deduction are documented. Task11 DOC-012 mobile signing completed (bounded): SQL111 `20261103005458`, SQL112 `20261103005609`, focused DB/API/React/build verification; actual HTTPS/mobile/legal-copy acceptance remains. Task12 OPS deployment readiness completed (bounded docs/source audit): API/updater address contract, current session/device revocation limits, diagnostics privacy, and separate DB+Storage recovery runbook recorded. No deploy, key injection, installation, or recovery drill performed. [Task12 audit](../../product/audits/2026-11-03-ops-deployment-readiness.md).
