# 2026-10-20 반복 예약 시리즈 (APT-16)

## 구현

- SQL 071 adds organization-scoped series, occurrence links, and exception dates. Each candidate is sent through the existing appointment/resource validation RPC. Conflicting slots are listed as skipped; if every candidate fails, the transaction rolls back.
- Supports weekly or monthly intervals, 2–52 occurrences, up to 52 exception dates, and retry-safe creation using operation ID plus a request fingerprint.
- The appointment form can create a series. Editing a linked appointment's date, time, customer, staff, service, or resource marks that occurrence as an exception. Cancellation continues through the existing versioned transition and audit history.

## 검증

- `node scripts/db-tests/appointments.mjs --series`: 통과. 실제 RPC에서 예외 날짜/충돌 회차 건너뛰기, 같은 요청 결과 재생, 회차 수정 표시, 다른 조직 권한 거절 확인.
- SQL 081을 추가해 최근 100개 반복 예약과 각 회차·예외를 읽는 조직 권한 RPC를 제공한다. 예약 화면의 `반복 예약` 버튼에서 목록, 현재 예약 일시와 상태, 개별 변경 표시, 예외일, 생성 시 건너뛴 회차 사유를 확인한다.
- SQL 082는 owner/admin이 실제 예약 시각의 KST 시작일 이후 아직 예약/확정 상태인 회차를 하나의 트랜잭션으로 취소하도록 한다. 방문·완료·취소된 회차와 시작일 이전 회차는 건드리지 않는다. 기존 예약 전이/감사 이력, 사유, 멱등 재시도를 사용한다. 화면에서 시작일·취소 사유를 지정하고 범위/건수를 확인한다.
- SQL 083은 owner/admin이 미래의 예약·확정 상태이며 개별 변경되지 않은 회차에 담당자와 시술을 일괄 적용한다. 서비스 소요 시간과 직원 충돌을 기존 예약 저장 RPC로 검증하며 하나라도 충돌하면 모두 롤백한다. 개별 예외·취소·방문 회차는 유지하고 업데이트 결과가 예외로 잘못 분류되지 않도록 보존한다. 같은 operation_id의 재시도는 확정 결과를 반환한다.
- SQL 085는 owner/admin이 시작 회차와 새 시작 일시를 고르면 그 뒤 개별 예외가 없는 미래 회차의 주기(주/월), 간격, 자원을 일괄 재계산한다. 회차 번호 차이로 누락·예외 회차 간 간격을 유지하고 각 예약은 기존 자원/시간 충돌 검사 RPC로 저장한다. 충돌이나 다른 사용자의 변경이 있으면 전부 롤백하며 operation_id로 같은 결과를 재시도한다.
- `pnpm --filter @business-assistant/api test -- src/routes/appointments.test.ts src/routes/appointmentHistory.test.ts`: 21 tests 통과.
- `pnpm --filter @business-assistant/desktop-react test -- src/features/appointments/AppointmentPage.test.tsx`: 55 tests 통과.
- API 및 React build 통과. React 빌드는 500KB 초과 chunk 경고가 남아 있다.

## 제한·운영 적용

- SQL 071, 081~085는 Supabase에 적용하지 않았다. 각각을 번호 순서대로 적용한 다음 API와 앱을 다시 시작해야 한다.
- 생성한 시리즈는 개별 예약 수정/취소, 미래 회차의 담당자·시술/날짜·주기·자원 변경, 시작일 이후 남은 예약/확정 회차 취소를 지원한다. 알림 발송은 남아 있다.
- 격리 PGlite 테스트는 SQL 로직 증거이며 실 Supabase RLS/권한/동시성 검증이나 실제 앱 업무 흐름 검증을 대체하지 않는다.

## 2026-10-20 추가 — 미래 일정 재배치

- `node scripts/db-tests/appointments.mjs --series`: 통과. 월 주기 재배치, 시작 일시 및 자원 변경, 이후 회차 충돌 시 선행 회차 롤백, 성공 뒤 재시도, 잘못된 주기·중복 자원·일반 구성원 거부, 다른 조직에서 조회되지 않는 동작을 확인했다. SQL 085는 테스트에서 재실행했다.
- `pnpm --filter @business-assistant/api test -- src/routes/appointments.test.ts`: 15개 통과. API/React 빌드 통과, React에 500KB 초과 chunk 안내가 남아 있다.
- `pnpm --filter @business-assistant/desktop-react test -- src/features/appointments/AppointmentPage.test.tsx`: 55개 통과.
- 화면 테스트는 요청 payload까지 확인했으며 실 Supabase 및 실제 데스크톱에서의 일정 재배치는 확인하지 않았다.
