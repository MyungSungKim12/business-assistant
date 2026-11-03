# 고객 메시지 대기열 구현 점검

기록일: 2026-11-03 · 범위: N1030-08 / MKT-001~003의 코드·SQL 검증

## 구현 범위

- 조직별 메시지 템플릿 버전, 고객 대상 미리보기, 제외 사유와 마스킹된 연락처를 React 화면/API/DB에 연결했다.
- enqueue 시점에 고객 조직·활성 상태·연락처·마케팅 동의를 다시 검사한다. 요청 재시도는 idempotency key로 중복을 억제하고, 취소와 최대 3회 제한 재시도를 기록한다.
- SQL109는 템플릿/outbox/요청 멱등성 테이블을 RLS로 보호하고 직접 authenticated 접근을 차단한다. 공개 RPC의 조직/역할 경계를 사용한다.
- provider readiness는 항상 false이며 queue 항목은 전송 대기 상태로만 나타난다. 공급자 응답을 전달 성공으로 표시하지 않는다.

## 검증 증거

- 격리 PGlite: `node scripts/db-tests/customer-messaging-109.mjs` 통과. 동의 철회, 휴면/연락처 없음, 조직 경계, 멱등 충돌, 취소/재시도, 권한 거부, 감사 이벤트를 확인했다.
- API: marketing focused suite 7 tests 통과.
- React: MarketingPage focused test 1개 통과.
- `pnpm api:build`, `pnpm react:build` 통과. React 번들 500KB 초과 경고는 기존 성능 작업으로 남는다.
- Supabase migration SQL109 version `20261103001028` 적용. 적용 후 신규 테이블 RLS enabled/direct authenticated select denied, 신규 고객 메시지 0건, 기존 고객 19명 유지 확인.

## 미완료 및 제한

- SMS/알림톡 공급자 계정·계약, 발송 worker, 서명된 callback/webhook·중복/순서 처리, 예약/회원권 자동 안내와 빈도 정책은 구현하지 않았다.
- 따라서 이 기능은 준비/대기열 단계이며 실제 메시지를 발송하지 않는다. MKT-004~007, 실제 조직 계정 인수는 잔여다.
- SQL Advisor의 전체 기존 경고를 이 범위에서 해결했다고 주장하지 않는다.
