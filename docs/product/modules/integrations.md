# 외부 연동

2026-10-30 INT-005~007 후속: 기존 VIP 전화 매칭, 전화 카드 번호 가림, 메인 창 수락 후 알림 닫기, Android 0.3.0 자동 번호부 전체 갱신·마지막 시각·동의/매장/계정 경계를 보완했다. 로컬 API/PC/Native/Kotlin 검증 통과, 새 APK 설치와 실제 백그라운드·수신 인수는 별도다. 서버 버전 증분 갱신과 영속 수신함은 후속이다. [증거·제한](../audits/2026-10-30-followup-hardening.md).

갱신일: 2026-10-23 · 상태: in-progress

## 목적·진입점

예약·메시지·결제 공급자와의 연결 상태와 실패를 관리한다. 업무 화면에서 진입하고 관리자용 설정은 공통 설정에 둔다.

## 기능 추적

| ID | 우선 | 상태 | 범위 |
| --- | --- | --- | --- |
| INT-001 | P0 | planned | 공식 API/계약 가능 여부 확인과 권한 연결 |
| INT-002 | P0 | planned | 마지막 동기화 시각·지연·실패 내역 |
| INT-003 | P1 | planned | 외부 ID 매핑·중복 이벤트·순서 역전 처리 |
| INT-004 | P1 | planned | 연결 해제·키 갱신·실패 재처리 |
| INT-005 | P1 | in-progress | 로그인 조직 한정 최소 고객 전화번호부·정확 일치 조회·전화 상담 메모 API 및 고객관리 수동 메모 UI. 서버/React 집중 검증 완료, 모바일 패키지 인수 대기 |
| INT-006 | P1 | verified (코드/SQL 한정) | 11/02 고객번호부 revision/cursor delta·tombstone와 Android atomic encrypted merge 구현. API25/Kotlin21·실제 PostgreSQL 별도연결·격리 SQL·debug APK build·독립 검토 통과, SQL105 `20261102065323` 원격 적용/ACL 확인. S23/Keystore/WorkManager 실기기 인수와 cleanup 운영은 별도. iOS Call Directory도 미지원. [감사](../audits/2026-11-02-phone-directory-incremental.md) |
| INT-007 | P1 | verified (코드/SQL 한정) | 11/02 DB 기반 2분 relay·선택 동의 30일 수신함·응대/배정/콜백·Android 0.4.0 동의/세대 무효화. API23/React24/Kotlin10·build/typecheck·격리 SQL·독립 검토 통과, SQL104 `20261102062807` 원격 적용 및 ACL 확인. 실기기/실제 JWT/다중 프로세스/정리 scheduler 인수는 별도. [검증/보유/제한](../audits/2026-11-02-durable-phone-inbox.md) |

## 데이터 계약

connection_id, provider, scope, external_id, cursor, last_success_at, event_id, retry_status. 식별자에는 조직 경계를 적용한다. 기존 API에 없는 필드는 구현 전에 계약과 마이그레이션을 검토한다.

## 업무·복구 흐름

공급자 계약/권한 확인 → 연결 → 테스트 동기화 → 운영 활성화. 끊긴 동안의 이벤트는 재연결 후 중복 없이 복구한다. 외부 API 미제공 기능을 연동 완료로 표시하지 않는다.

## 인수 조건

- [ ] 웹훅 재전송과 폴링이 같은 예약을 두 개 만들지 않는다. 키/토큰을 로그와 고객 화면에 노출하지 않는다.
- [ ] 오류·권한 부족·취소 결과를 사용자에게 표시하고 작성 중 입력을 보존한다.
- [ ] 성공 재시도·중복 이벤트·다른 조직 접근 사례를 테스트한다.

## 단계·검증 기록

2026-11-02 INT-007 영속 수신함 SQL104 `20261102062807`은 원격 적용했다. 기존 APK는 2분 알림만 복구하며 새 보관 동의 버전이 있는 전화만 30일 이력에 남는다. 실제 전화/설치 앱 인수는 별도다. [감사 기록](../audits/2026-11-02-durable-phone-inbox.md).

2026-10-23 독립 창의 범위, 검증 명령과 실환경 제한은 [전화 알림창 감사 기록](../audits/2026-10-23-native-call-popup.md)을 참조한다.
이후 고객 요약과 설정 배치 보완은 [고객 응대 요약 감사 기록](../audits/2026-10-23-call-customer-summary.md)을 참조한다.

소비 메뉴의 P0 흐름에 필요한 최소 기능부터 제공하고, 확장 기능은 별도 검증한다. 모바일 전화 연동 설계는 [설계 문서](../../superpowers/specs/2026-10-21-mobile-phone-companion-design.md), 실행 순서는 [계획](../../superpowers/plans/2026-10-21-mobile-phone-companion.md)을 참조한다. 2026-09-18 문서 작성; 모바일 연동 실환경 검증 없음. 기존 범용 API 존재는 이 문서의 전체 기능 완료 증거가 아니다. 상태 변경 시 [변경 이력](../changelog.md)에 증거와 제한을 기록한다.

[전체 계획](../README.md) · [품질 게이트](../quality-gates.md)
