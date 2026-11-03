# 10 고객 소통·마케팅

갱신일: 2026-11-03 · 담당: 제품/구현 담당자 · 현재 판정: MKT-001~003 범위 한정 구현 완료, 실발송 연동 전

## 목적과 사용자

접수 직원의 안내와 관리자의 캠페인을 고객별 응대 이력 및 실제 성과로 연결한다.

## 화면 구성

안내 템플릿/발송 대상/발송 내역/답변 처리함/캠페인 성과 탭. 보내기 전 대상 수·제외 사유·비용·내용을 함께 보여준다.

## 기능 추적

| ID | 우선 | 상태 | 구현 범위 |
| --- | --- | --- | --- |
| MKT-001 | P0 | verified (bounded) | 조직 템플릿·버전, 예약 안내 본문과 outbox. provider 연결 전 |
| MKT-002 | P0 | verified (bounded) | 고객 ID 기반 대상 미리보기, 동의/상태/연락처 제외 근거 |
| MKT-003 | P0 | verified (bounded) | 동의 재검사, 멱등 enqueue, 취소·제한 재시도·상태 이력 기반. 현재 대기열까지만 |
| MKT-004 | P0 | planned | 생일·회원권 만료·재방문 안내 |
| MKT-005 | P1 | planned | 최근 발송·응대 중 이슈를 고려한 연락 빈도 통제 |
| MKT-006 | P1 | planned | 고객 답변을 담당자의 후속 업무로 연결 |
| MKT-007 | P2 | planned | 캠페인별 예약·결제·재방문·순기여 비교 |

## 필드와 업무 규칙

- consent_record, purpose, channel, recorded_at, source: 동의 상태는 발송 시점에 다시 확인한다.
- campaign_id, audience_snapshot, template_version, scheduled_at, estimated_cost: 실제 대상과 사용 템플릿 보존.
- message_id, idempotency_key, provider_message_id, delivery_status, failure_reason: 채널의 수락/전달 상태를 구분한다.
- conversion_window, attribution_rule: 캠페인 성과 귀속 기준과 자연 재방문을 구분한다.

## 정상·취소·실패 흐름

1. 템플릿 선택 → 대상 조건 → 제외 고객 및 비용 확인 → 발송 승인 → 전달 결과 수신.
2. 예약 변경 직후 예약 취소가 발생하면 이전 안내 작업을 취소/대체한다.
3. 실패 사유별 재시도 가능한 건만 재전송하고 이미 전달된 메시지는 제외한다.
4. 고객 답변을 접수하면 담당자 배정 → 처리 → 고객 이력에 결과 연결.

## 연동과 단계

CRM 연락처/동의, APT 일정, TRT 후관리, WAL 만료, CARE 이슈, 외부 메시지 공급자.

1차는 P0의 실제 업무 흐름과 복구 경로를 검증한다. P1은 기본 데이터와 정정 흐름이 안정된 뒤 구현한다. P2는 외부 연동 계약 또는 충분한 데이터가 확보된 뒤 진행한다. 기존 범용 메뉴/API가 일부 있어도 이 문서의 기능 완료로 간주하지 않는다.

## 인수 조건

- [ ] 대상 선정 후 수신 거부한 고객은 실제 발송에서 제외된다.
- [ ] 공급자 응답 지연이나 웹훅 중복에도 같은 메시지가 이중 발송되지 않는다.
- [ ] 발송 실패를 예약 취소나 고객 이탈로 자동 간주하지 않는다.
- [ ] 다른 조직 데이터 접근과 권한 없는 변경이 서버에서 거부된다.
- [ ] 빈 상태·로딩·실패·재시도·동시 변경 시 사용자가 현재 상태를 알 수 있다.

## 검증 기록과 다음 작업

2026-11-03: MKT-001~003의 React 화면·API·SQL109 대기열 경로를 구현했다. 동의/고객 상태/전화번호는 미리보기와 enqueue 시점 모두 검사하고, idempotency key 충돌은 거부한다. PGlite 경계 테스트, API 7개, React 1개와 API/React 빌드를 통과했다. SQL109 `20261103001028` 원격 적용 후 신규 테이블 RLS와 직접 접근 차단, RPC 권한, 기존 고객 19명 및 신규 발송 0건을 확인했다. SMS/알림톡 공급자·worker·결과 webhook은 미구현이며 전달 성공으로 표시하지 않는다. MKT-004~007은 잔여다. [설계](../../superpowers/specs/2026-11-03-customer-messaging-design.md) · [계획](../../superpowers/plans/2026-11-03-customer-messaging.md) · [감사](../audits/2026-11-03-customer-messaging.md).

[전체 계획](../README.md) · [공통 품질 기준](../quality-gates.md)
