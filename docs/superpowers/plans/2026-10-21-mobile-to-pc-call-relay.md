# INT-007 휴대폰 수신 → PC 고객 알림 구현 계획

> **For agentic workers:** Use superpowers:executing-plans inline, task by task. Preserve unrelated changes; do not commit or change live database data.

**Goal:** 사용자가 명확히 요청한 Android 수신 전화 → PC 프로그램 고객 알림·메모를 현재 단일 PC API에서 시험한다. 휴대폰 고객 알림은 필요하지 않다.

**Architecture:** Android는 통화를 즉시 허용하고, 동의한 조직 번호부와 일치하는 수신만 암호화 큐/WorkManager로 서버에 전달한다. Fastify는 검증된 JWT subject와 crm.basic 조직 권한으로 범위를 고정하고 최근 2분의 이벤트를 메모리에서 유지한다. PC는 8초 long-poll로 같은 계정·조직 이벤트를 받아 포커스를 빼앗지 않는 알림을 표시하고, 사용자가 메모 버튼을 누르면 기존 전화 메모 대화상자를 연다.

**Tech Stack:** Kotlin/Android WorkManager, Node/Fastify/TypeScript, React/Tauri.

**Spec:** 원래 요청의 PC 알림이 기존 INT-005/006 범위에서 누락됐으므로 INT-007로 명시한다. 사용자 2026-10-21 답변: 휴대폰 알림은 불필요하며 PC 프로그램 알림이 목적이다.

## Global Constraints

- 동기화와 별도의 PC 전송 동의를 받는다. 알려진 조직 고객 번호만 전송하며 연락처 목록은 읽거나 업로드하지 않는다.
- 전화 허용 경로에서는 네트워크를 호출하지 않는다. WorkManager 입력에는 이벤트 ID만 넣고 번호/조직/시각 payload는 Keystore 암호화 저장소에서 읽는다.
- 서버는 같은 조직과 같은 로그인 계정으로만 전달한다. subject를 요청 본문/미검증 JWT에서 신뢰하지 않는다. OS 알림에는 이름/번호를 넣지 않는다.
- 최근 2분만 유지하고 event UUID 재전송은 중복을 만들지 않는다. 조회와 전송 모두 JWT/조직/CRM 권한을 확인한다.
- 이 단계는 단일 API의 실시간 알림이다. 서버 재시작·PC 미접속 동안의 수신 이력 보존, 다중 API 인스턴스의 공유 이벤트 저장은 배포 단계의 별도 작업이다. 메모만 기존 DB 원장에 저장한다. SQL 추가 없음.
- 잠금/로그아웃/계정·조직 변경 시 오래된 응답을 폐기하고 PII를 화면에 표시하지 않는다. 새 전화가 작성 중 메모를 덮어쓰지 않는다.

## Review Focus

- 다른 조직/다른 계정/CRM 미허용, 본문 actor 위조, 오래되거나 미래 이벤트.
- 중복 UUID/다른 내용으로 같은 UUID 재사용, 재시작 cursor, TTL/용량 상한.
- 폰 동기화 해제/로그아웃/조직 변경 뒤 대기 작업, 오프라인/재시도/권한 거부.
- PC long-poll 취소 후 다른 조직에 오래된 응답 표시, 잠금 상태, 작성 중 새 이벤트.

### Task 1: 서버 전달과 회귀 검증

**Files:** `apps/api/src/modules/phone/incoming-calls.ts`, `incoming-calls.test.ts`, `routes.ts`, `app.ts`.

- [x] 같은 계정/조직·만료·중복·위조·권한 테스트 RED.
- [x] POST/GET `/organizations/:id/mobile/incoming-calls`, JWT getUser 검증, 정확 번호 재검사, 메모리 TTL/상한/long-poll 구현.
- [x] 집중 API 21 tests와 TypeScript 검사 GREEN.

### Task 2: PC 알림과 메모

**Files:** API schema/client, `features/phone/IncomingCallAlerts.tsx`와 테스트, `PhoneMemoDialog.tsx`, `App.tsx`, CSS.

- [x] 이벤트 알림·중복/조직 변경·메모 실패 보존 테스트 RED.
- [x] 전역 알림/선택 메모/기존 입력 보호, generic OS 알림 연결.
- [x] 집중 React 27 tests + Native 8 tests와 타입 검사 GREEN.

### Task 3: Android 전달

**Files:** SecurePhoneStore/PhoneApi/CallScreeningService/MainActivity/layout, CallRelayWorker, Gradle/manifest, gateway allowlist.

- [x] PC 전송 동의, 암호화 대기 payload, WorkManager 전달·만료·재시도, 휴대폰 알림 제거.
- [x] Kotlin 6 tests·APK 0.2.0 빌드·게이트웨이 전송 경로 검증.

### Task 4: 현재 PC 시험과 기록

- [x] API/React/Android 집중 확인, HTTPS 다운로드 버전/해시 확인, 제품 상태/제한/가이드 갱신.
- [x] 새 APK와 QR 생성. 최종 응답에서 같은 계정·조직 및 권한/동기화/PC 전송 동의 조건을 안내한다.
- [ ] 실제 S23 전화→PC 팝업 인수. 이 전에는 verified로 표시하지 않는다.

검증 증거와 잔여 제한: [INT-007 감사](../../product/audits/2026-10-21-mobile-to-pc-call-relay.md).
