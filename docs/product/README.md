# 뷰티 매장 운영 제품 계획

기준일: 2026-09-17. HandSOS 유형의 고객·예약·매출 운영 흐름과 ERP의 재고·직원·정산을 연결하는 제품 요구사항이다. 특정 외부 제품의 현재 기능을 조사하거나 동일 구현을 보증하는 문서는 아니다. 기존 범용 Business Assistant를 기반으로 확장하며, 아래 12개 메뉴는 **목표 정보구조**이고 현재 내비게이션과 일치하지 않는다.

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

## 공통 지원 모듈

[데스크톱 디자인 기준 및 UI-001 진행](design-system.md): 공통 글꼴·컴포넌트 및 고객/시술 화면의 상품성 개선.

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

기존 [제품 개요](../01-product-overview.md), [아키텍처](../02-architecture.md), [메뉴 모듈](../03-menu-modules.md), [구현 로드맵](../06-implementation-roadmap.md)은 범용 앱의 배경과 기술 설명이다. 이 디렉터리는 뷰티 매장 제품의 상세 요구사항과 검증 추적을 담당한다. 기존 README의 구현 완료 문구를 상용 업무 완료의 증거로 사용하지 않는다.

2026-09-17 읽기 확인: `apps/desktop/src/business_assistant_desktop/menu_catalog.py`에는 15개 범용 메뉴가 있다. 고객·활동·시술 관련 API 소스가 있으나 이번 문서 작성에서는 API 실행, 데이터베이스 접근, 실환경 검증을 수행하지 않았다. 일정 권한 코드는 기존 설명의 `task.basic`과 카탈로그의 `schedule.basic`이 달라 통합 시 계약을 확인해야 한다. 목표 12개 메뉴의 권한 코드는 기존 코드에 임의로 매핑하지 않고 설정 모듈에서 결정한다.


## 최신 진행 — 2026-09-18

- 계획·적용 문서 26개: 12개 메뉴, 9개 공통 모듈, 인덱스/로드맵/품질/변경 이력과 시술 적용 안내. 고유 기능 ID 123개.
- CRM-001~007: 로컬 구현/검증 완료. [검증 근거와 제한](menus/02-customers.md)을 확인한다.
- 고객관리 이후 기능은 각 문서의 planned 상태를 유지한다. 모든 메뉴를 구현한 것이 아니다.
- [고객관리 실행 계획](../superpowers/plans/2026-09-17-customer-stage1.md), [코드 작업 규칙](../../AGENTS.md).
- 실제 고객 데이터나 외부 발송 없이 독립 화면 확인: `.venv/Scripts/python.exe scripts/preview-customer.py`.

- 2026-09-18: TRT-007 시술 기록 워크스페이스 로컬 검증 완료. 상세 범위·검증·후속 제한은 [시술관리](menus/04-consultations-treatments.md#trt-007-검증-기록--2026-09-18)를 참고한다.

- 2026-09-18: TRT-002 상태·정정 이력 로컬 검증 완료. 운영 반영은 [시술 적용 안내](treatment-lifecycle-release.md)의 migration/서버/앱 동시 적용 순서를 따른다.

## 최신 순차 진행 — 2026-09-22

TRT-001 상담 초안·주의 확인과 DOC-001 동의서·서식 버전 관리는 코드 구현 완료, Python·Qt·실환경 검증 대기(in-progress)다. 격리 DB 검증은 37개 묶음 통과했다. [서식 적용 안내](document-versions-release.md)에 호환성 변경과 다른 PC 검증 명령을 기록했다. 기존 9월 18일 실행 결과를 새 변경의 검증으로 해석하지 않는다.

2026-09-23: DOC-002/003 고객·시술 문서 자동 채움·검토·불변 발행 이력 코드 구현. 격리 DB 검증 총50개 묶음 및 Ruff 통과. Python/Qt/실환경은 검증 대기이며 실제 서명·교부는 미구현이다. [사용·적용 안내](document-issuance-release.md).
2026-09-28: DOC-004 현장 손서명·외부 교부 확인·철회 이력 코드를 추가했다. 격리 DB63개와 Ruff 통과. Python/Qt/실환경 검증은 대기다. [사용·검증 안내](document-consent-release.md).

2026-09-29: TRT-003 / SALE-001 시술 명세·동의 상태의 불변 결제 초안과 매출·지출 조회를 구현했다. 정상 실행이 가능해져 서버/common348, desktop159, 격리 DB75 검증 통과. 서버 health 및 데스크톱 로그인 창 기동 확인. 실환경 저장·전체 장바구니·수납은 미완료로 in-progress 유지. [사용·검증 안내](treatment-sale-drafts-release.md).

2026-10-06: SALE-001 안정화 및 SALE-002의 현금·카드·이체 수납 기록·부분 수금·재무 수입 연결 구현. 두 기능 in-progress 유지, 보조 환경의 검증 범위와 SQL024~026 적용 순서는 [수납 적용 안내](visit-payments-release.md)를 확인한다.
