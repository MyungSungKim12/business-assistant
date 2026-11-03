# N1030-02 / SET-001 매장 예약 정책

기준일: 2026-11-02. 선행 N1030-01 / SQL101 원격 적용(20261102004544) 이후의 순차 작업이다. 요구사항은 `docs/superpowers/plans/2026-10-30-product-task-02-brief.md` 및 상위 제품 설계의 2번만 적용했다. SET-001 전체 중 결제·할인 정책은 이번 범위가 아니다.

## 현재 상태

DB/API/React 구현과 아래 집중 로컬 검증을 완료했다. **SQL102는 로컬 작성·재적용 검증 상태이며 이 작업자는 원격 SQL을 실행하지 않았다.** 원격 적용 및 실제 사용자 JWT/앱 인수는 주 작업자가 별도로 기록한다. 기존 고객·예약·실데이터 변경, 커밋·배포, 전체 테스트, 실제 앱 실행은 수행하지 않았다.

## 저장 계약과 권한

- SQL: `migrations/102_organization_booking_policies.sql`. 기존 SQL034의 조직 역할 검사, SQL040의 append-only `audit_events`, 기존 예약 테이블/트리거를 사용한다. 조직당 하나이며 지점별 분기는 없다.
- `public.organization_booking_policies`: `organization_id uuid PK/FK`, `version bigint > 0`, `policy jsonb`, `updated_by uuid`, `updated_at timestamptz`. 정책 본문은 100,000 bytes 이하이다.
- `public.organization_booking_policy_operations`: `(organization_id, operation_id) PK`, `actor_id`, `fingerprint`, 저장 결과 snapshot, 생성 시각. 사용자 직접 테이블 읽기/쓰기는 허용하지 않고 RLS를 켠다. 정책/결과 접근은 RPC를 거친다.
- `get_organization_booking_policy(p_organization_id uuid) → jsonb`: 저장본 또는 `version=0` 기본본. 기본값은 `enabled=false`, `timezone_name='Asia/Seoul'`, `minimum_notice_minutes=0`, `same_day_cutoff_time=null`, `hours=[]`, `blocks=[]`이다. 조회가 행을 만들거나 기존 예약을 변경하지 않는다.
- `save_organization_booking_policy(p_organization_id uuid, p_expected_version bigint, p_operation_id uuid, p_policy jsonb) → jsonb`: 첫 저장은 expected version 0, 이후 현재 버전과 일치해야 한다. 같은 사용자/조직/operation ID/본문/expected version의 재요청은 이전 snapshot을 반환한다. 다른 입력·사용자 재사용 또는 오래된 버전은 `P0001` 충돌이다. 다른 관리자가 나중 버전을 저장한 뒤 이전 operation을 재시도하면 이전 snapshot이 반환되므로 UI에서 최신 정책을 불러와야 한다.
- 반환 본문: 정책 필드에 `organization_id`, `version`이 추가된다. 입력 policy는 정확히 `enabled`, `timezone_name`, `minimum_notice_minutes`, `same_day_cutoff_time`, `hours`, `blocks` 6개 필드다. timezone은 DB `pg_timezone_names`의 이름으로 검증하며 API/UI도 Intl 시간대 유효성을 검사한다.
- `hours`: 최대 70개 `{weekday:1..7,start_time:'HH:mm',end_time:'HH:mm'|'24:00'}`. 시작 < 종료, 여러 구간 허용. 중복·겹침은 명시적으로 허용하되 점유 구간 전체가 **한 구간** 안에 있어야 한다. 활성 정책에서 영업 구간이 없는 요일은 휴무다.
- `blocks`: 최대 200개 `{start_at:offset이 포함된 ISO datetime,end_at:동일,reason:최대 500자}`. 유한한 시작 < 종료, 한 구간 최대 366일. 겹침은 허용하며 하나라도 겹치면 차단한다. 목록 전체를 하나의 정책으로 저장하므로 부분 성공이 없다. reason은 예약 데이터에 가공해 붙이지 않는다.
- 최소 사전 시간은 정수 0..525600분, 접수 마감은 nullable `HH:mm`이다. API는 `GET/PUT /api/v1/organizations/:organizationId/booking-policy`. GET은 `task.basic` 조직 접근, PUT은 같은 기능과 owner/admin 권한을 요구한다. DB RPC는 JWT와 조직·역할을 다시 검사하며 `SECURITY DEFINER SET search_path=''`, PUBLIC/anon 실행 금지다. 정책 저장은 개인정보 없이 `booking_policy.saved` 감사 이벤트에 이전/새 버전·operation·활성 여부를 기록한다. 재시도는 감사 이벤트를 중복 생성하지 않는다.

## 예약 검사와 동시성

`appointments_organization_booking_policy`는 AFTER INSERT/UPDATE 행 트리거다. 기존 BEFORE 트리거가 계산한 최종 점유 구간 `[start_at, end_at + buffer)`을 사용해 직접 DML, `save_appointment`, 자원 예약 저장, 반복 예약 생성 및 미래 회차 변경·재배치를 모두 검사한다. 위반은 SQLSTATE `23514`이며 API에서는 422가 된다. 정책 저장은 기존 예약 행을 읽어 수정하거나 취소하지 않는다.

활성 상태는 reserved/confirmed/checked_in이다. 신규 활성 예약, 시간·담당·서비스·소요·여유 또는 조직 변경, 비활성 상태에서 활성 복귀 시 검사한다. 기존 활성 예약에서 검사 대상 값이 같으면 메모·예약/확정·방문 상태 변경을 막지 않으며, 완료·취소 등 비활성 상태 처리도 정책으로 막지 않는다. 기존 다른 예약 가드의 독립 제한은 계속 적용된다.

정책 저장은 `organization-booking-policy:<organization_id>`의 **exclusive transaction advisory lock**, 검사 대상 예약 쓰기는 같은 키의 **shared transaction advisory lock**을 잡은 뒤 정책을 읽는다. 아직 정책 행이 없는 조직도 같은 키로 직렬화한다. 예약끼리는 기존 직원·자원 잠금을 계속 사용한다. 정책 저장은 예약/직원/자원 행 잠금을 취하지 않아 정책 변경에서 예약 행으로 돌아오는 잠금 순서를 추가하지 않는다. 정책 변경 전 완료된 저장은 당시 정책으로 승인되고, 새 정책 커밋 뒤 검사하는 예약은 새 정책을 읽는다. PGlite는 실제 다중 DB 세션의 잠금 대기를 입증하는 도구가 아니므로 이 동시성 계약의 실제 PostgreSQL 2-session 부하/대기 검증은 남아 있다.

최소 사전 시간은 접수 statement 시각에서 예약 시작까지 계산한다(경계 일치 허용). 당일 마감은 **접수 시각**이 매장 현지 마감 이상이고 예약 시작의 현지 날짜가 오늘일 때 거절한다. 미래 현지 날짜 예약은 이 마감 조건에서 제외된다. 영업시간과 날짜 판정은 매장 timezone, 화면 날짜와 직접 차단 입력은 기존 KST를 유지한다. 블록은 절대 시각의 반개구간이다.

독립 검토 중 DST 시계 되돌림에서 양끝 현지 시각만 비교하면 중간 닫힌 시간을 통과하는 문제가 재현됐다. 이를 명시적으로 제한했다. **활성 정책에서 점유 구간이 timezone offset 전환을 가로지르면 `booking_policy_timezone_transition`으로 거절한다.** 시작과 exclusive end 직전의 offset을 비교하므로 전환 시각에 정확히 끝나는 예약은 이 이유로 거절하지 않는다. SQL과 JS 모두 마지막 점유 순간으로 영업 종료 경계도 판단한다. 봄/가을 전환을 통과하는 예약 지원은 후속이며 일반 IANA 예약과 Asia/Seoul 기본값은 지원한다. API advisory와 화면에도 제한을 설명한다.

## 조회/추천과 화면

실제 appointment resource gateway에 필수 `getBookingPolicy`를 추가했다. 두 availability 경로는 요청당 한 정책 snapshot을 다른 기준과 함께 읽고 같은 `bookingPolicyBlock`으로 buffer를 포함한 슬롯을 제거한다. 정책 조회 오류/누락/다른 조직 응답을 무제한 영업으로 숨기지 않는다. 추천 설명과 advisory에 매장 정책을 포함하며 거절 이유는 UI 응답 스키마/설명에도 등록했다. 배포 시 SQL102를 API보다 먼저 적용해야 한다.

예약 페이지의 기존 관리 액션 옆에 `매장 예약 정책` 진입점을 추가했다. `canManageResources`가 없는 사용자는 `예약 정책 보기`로 동일 정책을 읽고 입력·저장 기능은 비활성이다. 기존 Modal·resource form·버튼 스타일을 재사용했다. 활성 여부, timezone, 최소 사전 시간, 당일 접수 마감, 주간 복수 영업 구간, 절대 차단, 현지 날짜의 하루 휴무를 읽고 편집한다. 하루 휴무는 해당 매장 timezone의 두 자정을 각각 절대 시각으로 변환하므로 DST 날짜의 23/25시간도 유지한다. 현지 자정 자체가 존재하지 않는 특수 날짜는 자동 변환을 거절하고 직접 절대 차단 입력을 안내한다.

정책 수정과 아직 목록에 추가하지 않은 차단/휴무 입력을 DraftBoundary에 dirty로 등록하고 저장 중 busy를 등록한다. 닫기/새로 읽기는 미저장 입력 확인을 거친다. 저장 실패 시 입력과 재시도 operation ID를 유지하고 최신 정책을 다시 불러올 수 있다. 저장 중 입력·취소·중복 저장을 막는다. 조직 변경은 페이지의 조직 key로 모달을 분리하고 모달 내부에서도 오래된 응답을 무효화한다. 읽기 전용 전환 시 저장 액션이 사라진다.

## 집중 검증 증거

2026-11-02 로컬 실행:

| 명령 | 결과·검증 범위 |
| --- | --- |
| `pnpm --filter @business-assistant/api test src/modules/booking-policy src/modules/appointment-resources src/routes/appointments.test.ts` | **9 files / 120 tests PASS**. 정책 권한/검증/오류 매핑, tenant response 거절, 정책 필수 조회, 두 availability 경로의 동일 슬롯 필터, 기존 예약/자원/직원 동선 |
| `pnpm --filter @business-assistant/desktop-react test src/features/appointments/BookingPolicyDialog.test.tsx src/features/appointments/bookingPolicy.test.ts src/features/appointments/availability.test.ts src/features/appointments/AppointmentPage.test.tsx` | **4 files / 70 tests PASS**. 저장 실패/동일 operation 재시도, 미저장 취소 확인, 잘못된 시간 입력 유지, 읽기 실패 재시도, member 읽기 전용, pending 입력/busy DraftBoundary, 조직 응답 경쟁/권한 전환, 실제 페이지 진입, 현지 하루 휴무 23/25시간, 기존 메모/편집 보호 |
| `node scripts/db-tests/booking-policy-102.mjs` | **PASS**. SQL102 두 번 적용, disabled default, buffer/점심/닫힘·자정 경계, 절대 차단 양끝, 직접/복수 예약 삽입 거절과 전체 롤백, 기존 메모·방문·완료·취소 허용/활성 복귀 거절, 버전/actor/operation 충돌, 중복 감사 방지, owner/admin/member/비회원/다른 조직/JWT 없음/anon/직접 정책 DML 거절, 시간대/접수 마감/notice·DST 전환 경계 |
| `node scripts/db-tests/appointments.mjs --series --booking-policy` | **PASS**. 실제 SQL034/037/038 및 반복 생성·미래 변경/재배치 RPC에 SQL102를 적용. 실제 저장 두 경로 거절, 뒤 회차 정책 위반 시 앞 회차까지 롤백, 미래 담당/시술 및 일정 변경 거절·원본 유지, 기존 예약 방문·완료·취소 허용 |
| `pnpm --filter @business-assistant/api exec tsc --noEmit` | PASS |
| `pnpm --filter @business-assistant/desktop-react exec tsc -p tsconfig.app.json --noEmit` | PASS |
| `git diff --check -- apps/api/src/modules/appointment-resources apps/desktop-react/src/features/appointments scripts/db-tests/appointments.mjs docs/product/modules/settings.md` | PASS. 기존 파일 CRLF→LF 안내만 출력 |

테스트 우선으로 정책 및 availability/DST의 누락 동작을 재현한 뒤 구현했다. 기존 React 묶음 첫 실행 중 `서버에서 선택 예약이 다른 날짜로 이동해도 memo 입력이 사라지지 않는다`가 한 번 실패했다. 즉시 해당 이름만 실행했을 때 edit/memo 2건 모두 통과했고, 위 최종 70건 실행에서도 모두 통과했다. 메모 기능 코드는 변경하지 않았다. 최초 실패를 숨기거나 전체 테스트 통과로 표현하지 않는다.

화면 증거는 Testing Library의 실제 Modal/예약 페이지 DOM 검증이다(관리/조회 버튼, disabled 상태, 입력 보존, 오류·재시도, DraftBoundary 콜백). 실제 앱 실행·스크린샷·Windows/Tauri 인수는 수행하지 않았다. 원격 실제 JWT와 다중 세션 경합, 설치 버전·신구 서버 배포 조합의 실환경 검증은 남아 있다.

## 변경 파일

- 신규: `apps/api/src/modules/booking-policy/{schemas,gateway,policy,routes}.ts`, `policy.test.ts`, `routes.test.ts`.
- 연결: `apps/api/src/modules/appointment-resources/{gateway,index,availabilityRoutes,availability}.ts`; 관련 `availability.test.ts`, `availabilityBatch.test.ts`.
- UI: `apps/desktop-react/src/features/appointments/BookingPolicyDialog.tsx`, `bookingPolicy.ts` 및 각각의 테스트; 기존 `AppointmentPage.tsx`, `AppointmentPage.test.tsx`, `availability.ts`.
- DB: SQL102, `scripts/db-tests/booking-policy-102.mjs`, 기존 `appointments.mjs`의 opt-in `--booking-policy` 시나리오.
- 제품 문서: SET-001의 이번 구현 범위를 verified (범위 한정)로 갱신했다. 결제·할인 정책과 실제 앱 인수는 별도 잔여다.
- 원격 적용 (2026-11-02): Supabase `business-assistant` migration `102_organization_booking_policies` version `20261102005828` 성공. 테이블 2개 RLS 활성화, authenticated/anon 직접 SELECT 거부, RPC 인증/비인증 호출 경계 및 AFTER 예약 트리거 확인. 기존 예약 23건·고객 19명 유지, 정책/operation 새 기록 0건. 이는 코드/DB 집중 확인이며 실제 화면 인수는 아니다.
