# 뷰티 매장 운영 제품 계획

기준일: 2026-10-20. 이 문서는 뷰티 매장의 고객·예약·시술과 ERP의 매출·회원권·재고·직원·정산을 연결하는 제품 요구사항 및 진행 상태의 기준점이다. HandSOS·LCID 등 참고 제품의 현재 기능을 조사하거나 동일 구현을 보증하지 않는다.

현재 코드는 **React 19 + Tauri 2 데스크톱 앱, Node.js/TypeScript + Fastify API, Supabase Auth/PostgreSQL/Storage**를 사용한다. PySide6 클라이언트와 Python FastAPI 업무 서버는 제거됐다. 개발 실행은 `run-app.cmd`가 API와 Tauri 창을 함께 시작한다. 브라우저 미리보기는 UI 개발용이다.

전체 기능을 테스트할 때는 [전체 기능 테스트 흐름](functional-test-flows.md)을 따른다. 2026-10-20에 사용자가 전달한 SQL 집계에는 고객 16명, 예약 3건, 시술 기록 13건, 장바구니 8건 등 주요 기능 데이터가 있었다. 대기 목록과 반복 지출 템플릿은 각각 0건이었다. 이 집계는 사용자가 전달한 스냅샷이며 원격 DB 직접 조회나 실사용 인수 결과가 아니다. 따라서 데이터 대량 추가보다 테스트 조직의 QA 전용 기록을 분리해 연결 흐름과 실패/권한/재시도를 확인하는 것이 다음 단계다.

구현된 업무 화면은 대시보드, 할 일, 고객, 예약, 시술, 매출, 회원권, 재고, 서비스, 직원, 정산, 문서, 파일, 경영, 구성원, 플랫폼 구독이다. 구현 여부와 운영 인수 여부는 다르다. 2026-10-13 인수 기록 기준으로 실 Supabase의 주요 쓰기·복구 흐름, Windows 설치·업데이트는 추가 인수가 필요하다. [현재 인수인계](handoff-2026-10-13.md)와 [React/Tauri 기능 대응표](react-tauri-parity.md)를 확인한다.

## 메뉴별 상세 계획

| 순서 | 메뉴 | 기준 접두어 | 핵심 산출물 |
| --- | --- | --- | --- |
| 01 | [대시보드](menus/01-dashboard.md) | DASH | 오늘 할 일과 검증 가능한 운영 지표 |
| 02 | [고객관리](menus/02-customers.md) | CRM | 고객 프로필과 고객별 활동 기록 |
| 03 | [예약](menus/03-appointments.md) | APT | 직원·공간 중복 없는 예약과 방문 처리 |
| 04 | [상담·시술](menus/04-consultations-treatments.md) | TRT | 상담, 동의, 시술, 사진 이력 |
| 05 | [결제·매출](menus/05-payments-sales.md) | SALE | 결제·환불·미수금 원장 |
| 06 | [회원권·패키지](menus/06-memberships-packages.md) | WAL | 충전·회차·사용·환불 원장 |
| 07 | [상품·재고·구매](menus/07-products-inventory-purchase.md) | INV | 입출고와 발주·입고 연결 |
| 08 | [직원·수당](menus/08-staff-commissions.md) | TEAM | 근무·담당·수당 확정 |
| 09 | [비용·정산·손익](menus/09-expenses-settlement-profit.md) | FIN | 현금 정산과 관리손익 |
| 10 | [고객 소통·마케팅](menus/10-communications-marketing.md) | MKT | 동의 기반 발송과 재방문 성과 |
| 11 | [고객 이슈·사후관리](menus/11-customer-issues-aftercare.md) | CARE | 담당자·기한 있는 후속 관리 |
| 12 | [분석·경영 실험실](menus/12-management-lab.md) | LAB | 재현 가능한 지표와 가정 기반 시뮬레이션 |

## 현재 구현·남은 작업

- **예약·방문과 개별 시술 연결:** [2026-10-20 명시 연결·이력](audits/2026-10-20-treatment-visit-link.md). 기록별 연결·해제, 버전/멱등/범위 검사를 구현했다. SQL 064는 사용자가 실행 완료를 보고했으며, 원격 독립 확인과 실환경 검증은 하지 않았다. 연결 방문과 수납 가져오기의 일치 검사는 후속이다.

- **시술 전 확인:** [2026-10-20 주의사항·동의 문서 안내](audits/2026-10-20-treatment-preflight.md). 최신 주의정보·상담 확인 상태와 발행본별 서명·철회·증빙 확인을 연결했다. 추가 SQL 없음. 서비스별 필수 동의 정책·시작 시 발행본 고정은 후속이다.

- **예약 가능 시간 조회:** [2026-10-20 묶음 조회·입력 완전성](audits/2026-10-20-availability-batch.md). 직원별 반복 호출과 잘린 충돌 데이터를 보완하고 입력 debounce·재확인을 연결했다. 추가 SQL 없음.

- **Native 요청 제한:** [2026-10-19 통신 deadline·미확인 결과](audits/2026-10-19-native-http-deadline.md). API·파일 무제한 대기를 제한하고 기존 수납 복구를 검증했다. 추가 SQL 없음, Native 앱 재빌드/재시작 필요.

- **직원·고객 프로필:** [2026-10-19 담당자 수명주기·고객 입력](audits/2026-10-19-staff-customer-profiles.md). 이름·담당 중지/재활성화와 고객 주요 필드를 연결했다. SQL 063 사용자 적용 완료 보고.

- **노쇼·상태 이력:** [2026-10-19 예약 상태 이력](audits/2026-10-19-appointment-status-history.md). 사유 보존·원자 기록·상세 조회를 보완했다. SQL 062 사용자 적용 완료 보고, 실환경 미검증.

- **대량 목록 누락 보완:** [2026-10-19 발주·파일 목록](audits/2026-10-19-complete-large-lists.md). 내부 페이지 순회·완전성 검증·실패 재시도를 보완했다. 추가 SQL은 없다.

- **최근 방문 지표 연결:** [2026-10-19 실제 방문·다음 예약](audits/2026-10-19-customer-visit-facts.md). 수기 프로필을 보존하며 고객관리·홈을 원장에 연결했다. SQL 061까지 사용자 적용 완료 보고를 기록했다. 원격 독립 확인은 하지 않았다.

- **최근 예약 업무 연결:** [2026-10-19 예약→고객·시술·기존 방문 수납](audits/2026-10-19-appointment-handoff.md). SQL 060 사용자 적용 보고를 기록했으며 이번 추가 SQL은 없다.

- **현재 진행 기준:** [개선·추가 작업 목록](backlog.md)
- **전체 기능 테스트 순서와 결과 기록:** [전체 기능 테스트 흐름](functional-test-flows.md)
- **감사 후 보완 결과:** [예약 상세·운영 안전성 보완](audits/2026-10-16-appointment-hardening-followup.md) — 예약·입력 보호·입고 복구와 SQL 060. 원격 미적용·실환경 미검증 범위를 구분한다.
- **현재 소스의 독립 점검:** [2026-10-16 최초 인수 관점 점검](audits/2026-10-16-fresh-source-audit.md) — 기존 완료 표시를 근거로 삼지 않고 예약·업무 연결·권한·재시도를 점검했다. 재현한 결함과 제품 보완 제안을 구분한다.
- **실환경 검증과 출시 전 남은 일:** [인수인계](handoff-2026-10-13.md)
- **기술 전환·화면별 대응:** [React/Tauri 기능 대응표](react-tauri-parity.md)
- **최근 변경:** [변경 이력](changelog.md)
- **사용자·관리자·개발자 안내:** [통합 가이드](../index.md)

우선순위는 신규 메뉴 확장보다 테스트 조직에서 고객·예약·상담·시술·수납·재고·환불·마감의 전체 흐름을 인수하고, 배포 API와 서명된 Native 설치본을 검증하는 것이다. P2에는 시술 소모품/회원권 차감(TRT-11)과 감사 로그 조회·보관 정책(SEC-10)이 남아 있다. 자세한 제한은 각 기능 문서와 backlog를 따른다.

## 공통 지원 모듈

[Node/TypeScript API 전환 설계](../superpowers/specs/2026-10-13-node-api-migration-design.md): 전환 당시의 목표와 결정 기록. 실제 전환은 완료됐으며 현재 동작 기준은 `apps/api`와 [기능 대응표](react-tauri-parity.md)다.

[React/Tauri 데스크톱 전환 설계](../superpowers/specs/2026-10-12-react-tauri-desktop-migration-design.md): 전환 당시의 목표·결정 기록. 전환 뒤 PySide6 실행 코드는 제거됐다. 설계 및 구현 계획 문서는 작업 이력으로 보존한다.

[데스크톱 디자인 기준 및 UI-001 진행](design-system.md): 공통 글꼴·컴포넌트 및 고객/시술 화면의 상품성 개선.

[상품형 UI 전략](ui-product-strategy.md): Codex·Claude식 앱 셸, 정보 밀도, 상세 패널과 공통 상태 표현 기준.

[2026-10-08 기능 인수 점검](functional-release-check-2026-10-08.md): 1~6 우선순위의 로컬 증거, 신규 SQL 순서, 실제 화면 인수와 미완료 범위.

[예약 공간·장비 적용 안내](appointment-resources-release.md): 038 자원 마스터·서비스 필수 기준·동시간 충돌 차단과 실환경 인수 순서.

[문서](modules/documents.md), [미디어](modules/media.md), [가져오기·내보내기](modules/import-export.md), [자동화](modules/automation.md), [AI](modules/ai.md), [알림](modules/notifications.md), [외부 연동](modules/integrations.md), [설정·권한·구독](modules/settings.md), [다지점](modules/multi-branch.md).

## 문서 운영 규칙

- 기능 ID는 `CRM-001`처럼 메뉴 접두어와 세 자리 번호로 고정한다. ID는 삭제·재사용하지 않는다. 분할 시 신규 ID와 원래 ID의 관계를 변경 기록에 남긴다. 화면명·메뉴 순서를 바꾸어도 ID는 유지한다.
- 우선순위: P0는 해당 단계의 실운영 필수, P1은 효율·통제 확장, P2는 고도화다. P0라고 현재 구현되었거나 이번 작업 범위에 포함된 것은 아니다.
- 상태: `planned`는 요구사항만 합의, `baseline`은 관련 코드/API 존재를 읽어서 확인했으나 업무 완결성 미검증, `in-progress`는 구현·보완·검증 진행, `verified`는 명시된 인수 조건을 증거로 통과한 상태다. 미완료 기능을 화면 모형이나 CRUD 존재만으로 verified로 올리지 않는다.
- 상태 변경 시 기능 행, 해당 문서의 검증 기록, [변경 이력](changelog.md)을 함께 갱신한다. 담당자, 날짜, 커밋, 테스트 명령·결과, 화면 증거, 잔여 제한을 기록한다. 실제 외부 연동이 필요한 기능은 모의 테스트와 실환경 검증을 구분한다.
- 실패가 발견되면 verified를 in-progress로 되돌리고 회귀 사례를 등록한다. 메뉴 전체 완료율은 정의하지 않는다. 기능별 검증 범위를 읽는다.
- 각 문서의 필드 표는 목표 계약이다. 현재 API와 일치하는 항목은 별도 표시하고, 새로운 필드·상태는 구현 전에 요청/응답·마이그레이션·권한 계약으로 구체화한다.
- 전 메뉴에 [품질 게이트](quality-gates.md)가 적용된다. 빈 상태, 오류, 취소, 조직 경계, 읽기 전용 상태도 인수 조건이다.

## 구현 순서와 기존 문서 관계

[로드맵](roadmap.md)의 순서로 고객 → 예약 → 시술 → 결제 → 회원권·재고 → 정산 → 분석을 연결한다. 지원 모듈은 소비 메뉴보다 먼저 필요한 최소 기능을 제공한다. 회원권 차감, 재고 감소, 매출 확정처럼 여러 메뉴에 걸친 변경은 각각 독립 저장으로 흩어 놓지 않고 일관된 업무 전환으로 설계한다.

기존 [제품 개요](https://github.com/MyungSungKim12/business-assistant/blob/main/docs/01-product-overview.md), [아키텍처](https://github.com/MyungSungKim12/business-assistant/blob/main/docs/02-architecture.md), [메뉴 모듈](https://github.com/MyungSungKim12/business-assistant/blob/main/docs/03-menu-modules.md), [구현 로드맵](https://github.com/MyungSungKim12/business-assistant/blob/main/docs/06-implementation-roadmap.md)은 범용 앱의 배경과 기술 설명이다. 이 디렉터리는 뷰티 매장 제품의 상세 요구사항과 검증 추적을 담당한다. 기존 README의 구현 완료 문구를 상용 업무 완료의 증거로 사용하지 않는다.

현재 상단 메뉴와 화면 연결의 기준은 `apps/desktop-react/src/features/shell/menuCatalog.ts`, `TopBar.tsx`, `apps/desktop-react/src/app/Workspace.tsx`다. 메뉴는 조직 역할과 구독 권한에 따라 달라질 수 있다.

## 과거 진행 기록 — 보존본

아래 날짜별 항목은 당시 작업과 검증 내용을 보존한 기록이다. 현재 상태 판단에는 위의 backlog, 기능 대응표, 최신 인수인계를 우선한다. 당시의 Python/Qt 명령, 미완료 상태, 다음 작업 문구를 현재 안내로 사용하지 않는다.

### 2026-09-18 당시 기록

- 계획·적용 문서 26개: 12개 메뉴, 9개 공통 모듈, 인덱스/로드맵/품질/변경 이력과 시술 적용 안내. 고유 기능 ID 123개.
- CRM-001~007: 로컬 구현/검증 완료. [검증 근거와 제한](menus/02-customers.md)을 확인한다.
- 고객관리 이후 기능은 각 문서의 planned 상태를 유지한다. 모든 메뉴를 구현한 것이 아니다.
- [고객관리 실행 계획](https://github.com/MyungSungKim12/business-assistant/blob/main/docs/superpowers/plans/2026-09-17-customer-stage1.md), [코드 작업 규칙](https://github.com/MyungSungKim12/business-assistant/blob/main/AGENTS.md).
- 실제 고객 데이터나 외부 발송 없이 독립 화면 확인: `.venv/Scripts/python.exe scripts/preview-customer.py`.

- 2026-09-18: TRT-007 시술 기록 워크스페이스 로컬 검증 완료. 상세 범위·검증·후속 제한은 [시술관리](menus/04-consultations-treatments.md#trt-007-2026-09-18)를 참고한다.

- 2026-09-18: TRT-002 상태·정정 이력 로컬 검증 완료. 운영 반영은 [시술 적용 안내](treatment-lifecycle-release.md)의 migration/서버/앱 동시 적용 순서를 따른다.

## 최신 순차 진행 — 2026-09-22

2026-10-08: SALE-003 상품 수량 일부 반품·원영수증 환불·선반품 고려 전체 취소 재고 복원을 로컬 구현했다. 031 적용, 실 Supabase·Windows 화면 인수 대기. 다음 우선 작업은 SALE-004 할인 규칙이다. [고객 상품 반품 적용 안내](customer-product-returns-release.md).

2026-10-08 추가: SALE-004 수동 정액·비율 할인, 서버 재계산, 첫 수납 전 잠금, 변경 이력과 반품 할인 배분을 로컬 구현했다. Supabase 적용은 031 다음 032 순서이며 실환경 인수는 대기다. 다음 P0은 SALE-005 일 마감·미수 목록이다. [할인 적용 안내](sale-cart-discounts-release.md).

2026-10-08 추가: SALE-005 1차 범위로 일 마감·미수 목록·관리자 승인 정정 기록을 로컬 구현했다. 운영 DB에는 030까지 적용했다고 보고받았으며 신규 적용 순서는 031 → 032 → 033이다. 실환경 검증 대기. [일 마감 적용 안내](sale-daily-settlement-release.md).

2026-10-12 최신 사용자 보고: 031~036 SQL은 모두 실행했다. 현재 작업 환경에 서비스 키가 없어 독립 확인은 대기 중이다. 이후 로컬 구현 SQL은 037 예약 담당자 근무시간·휴무와 038 공간·장비 충돌이다. 실제 적용 순서는 037→038이며 기능별 검증 범위와 미완료 항목은 [예약](menus/03-appointments.md), [회원권](menus/06-memberships-packages.md), [직원](menus/08-staff-commissions.md), [손익](menus/09-expenses-settlement-profit.md)에 기록한다.

TRT-001 상담 초안·주의 확인과 DOC-001 동의서·서식 버전 관리는 코드 구현 완료, Python·Qt·실환경 검증 대기(in-progress)다. 격리 DB 검증은 37개 묶음 통과했다. [서식 적용 안내](document-versions-release.md)에 호환성 변경과 다른 PC 검증 명령을 기록했다. 기존 9월 18일 실행 결과를 새 변경의 검증으로 해석하지 않는다.

2026-09-23: DOC-002/003 고객·시술 문서 자동 채움·검토·불변 발행 이력 코드 구현. 격리 DB 검증 총50개 묶음 및 Ruff 통과. Python/Qt/실환경은 검증 대기이며 실제 서명·교부는 미구현이다. [사용·적용 안내](document-issuance-release.md).
2026-09-28: DOC-004 현장 손서명·외부 교부 확인·철회 이력 코드를 추가했다. 격리 DB63개와 Ruff 통과. Python/Qt/실환경 검증은 대기다. [사용·검증 안내](document-consent-release.md).

2026-09-29: TRT-003 / SALE-001 시술 명세·동의 상태의 불변 결제 초안과 매출·지출 조회를 구현했다. 정상 실행이 가능해져 서버/common348, desktop159, 격리 DB75 검증 통과. 서버 health 및 데스크톱 로그인 창 기동 확인. 실환경 저장·전체 장바구니·수납은 미완료로 in-progress 유지. [사용·검증 안내](treatment-sale-drafts-release.md).

2026-10-06: SALE-001 안정화 및 SALE-002의 현금·카드·이체 수납 기록·부분 수금·재무 수입 연결 구현. 두 기능 in-progress 유지, 보조 환경의 검증 범위와 SQL024~026 적용 순서는 [수납 적용 안내](visit-payments-release.md)를 확인한다.
