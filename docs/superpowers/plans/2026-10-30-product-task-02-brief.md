# N1030-02 / SET-001 매장 예약 정책 요구사항

상위 설계: `docs/superpowers/specs/2026-10-30-product-completion.md`의 2번. 이 파일이 작업 요구사항의 단일 기준이다. 1번 검증·SQL 적용 뒤 순차 구현한다.

## 현재 연결

- 실제 예약 저장: `apps/api/src/supabase/appointments.ts` → `public.save_appointment`, 생성/변경/반복은 `public.appointments`를 쓴다.
- 원격 현재 트리거: `appointments_assign_branch`, `appointments_enforce_service_staff`, `appointments_resource_guard`, `appointments_staff_availability`, `require_active_appointment_staff`, `appointment_series_mark_exception`.
- 빈 시간: `apps/api/src/modules/appointment-resources/availabilityRoutes.ts`의 `loadAvailability`와 `availability.ts` 순수 계산. 직원 일정 묶음·자원 요구·서비스별 담당 필터는 이미 존재한다.
- 설정 화면: `SettingsDialog`는 현재 기기 설정만 받는다. 매장 업무 정책은 예약/서비스 관리의 기존 관리자 진입점에서 독립 모달로 연결하거나 App에서 현재 조직/API를 전달하는 기존 패턴을 재사용한다. 기존 폰트·CSS/상단 메뉴를 리디자인하지 않는다.

## 구현 결정

1. 조직당 하나의 정책을 저장한다. 기본값은 `enabled=false`, `timezone_name='Asia/Seoul'`, `minimum_notice_minutes=0`, `same_day_cutoff_time=null`. 기본 비활성으로 기존 예약 동작을 보존한다. 지점별 정책은 이번 범위가 아니다.
2. 주간 영업시간은 ISO 요일 1~7과 복수 `[start_time,end_time)` 구간을 허용해 점심 휴게를 표현한다. 정책 활성 시 점유 구간(시술+buffer) 전체가 한 영업 구간에 들어와야 한다. 유효한 IANA timezone을 검증하며 현행 화면 날짜는 KST라는 조건을 유지한다.
3. 날짜별 예외는 절대 `start_at/end_at` 차단 구간과 사유다. 전체 휴무는 해당 매장 현지 날짜의 전체 구간으로 저장할 수 있다. 중복 차단은 정규화하거나 명확히 허용하되 잘못된 역전/무한 범위는 거절한다. 목록·입력은 상한을 두고 부분 성공을 반환하지 않는다.
4. `same_day_cutoff_time`은 **예약 접수 시각** 기준이다. 매장 현지 오늘의 예약을 마감 시각 이후 신규 접수/시간 변경하지 못한다. 미래 날짜 예약과 구분한다. minimum notice는 현재 시각부터 예약 시작까지 최소 분이다.
5. 생성·예약 시간/담당/서비스·점유 길이 변경·비활성에서 활성 상태 복귀는 검사한다. 메모만 수정/기존 예약의 방문·완료/취소 처리는 정책 변경으로 방해하지 않는다. 정책을 켜거나 바꿔도 기존 예약을 자동 취소/수정하지 않는다.
6. DB guard로 직접 저장·기존 반복 생성/미래 재배치에도 공통 적용한다. 추가 API 사전 검사만으로 우회 가능하게 만들지 않는다. 정책 변경과 예약 저장의 잠금 순서/동시성도 검토한다.
7. API 읽기는 조직 `task.basic` 접근, 변경은 owner/admin. DB RPC도 JWT·조직·역할을 확인하고 `search_path=''`, anon/PUBLIC 실행 차단. 버전+operation ID로 수정 충돌/응답 유실 재시도를 구분한다. 정책 변경은 감사 기록에 남긴다.
8. 추천은 동일한 정책 스냅샷으로 불가 슬롯을 제거하고 추천 설명/advisory에 매장 정책을 포함한다. 정책 조회 실패를 무제한 영업으로 숨기지 않는다. 새로운 DB가 필요한 실제 gateway는 항상 정책을 조회한다.
9. 관리 화면에서 주간 시간·차단·접수 마감·최소 사전 시간을 읽고 저장/취소/재시도한다. 미저장/저장 중에는 DraftBoundary에 연결한다. 읽기 전용 사용자는 정책은 보되 변경하지 못한다.

2026-11-02 검토 보완: 시간대 offset 전환을 가로지르는 점유 구간은 SQL/JS에서 같은 명시적 사유로 보수적으로 거절한다. 배타적 종료 직전 offset을 사용한다. 현지 시각 시작/종료 값만으로 서머타임 되돌림 구간을 허용하지 않으며, 이 제한을 문서/안내에 남긴다. rollback·spring-forward 및 전환 시각에 정확히 끝나는 경우를 집중 검증한다.

## 예상 파일과 인터페이스

- 새 SQL 번호는 직전 작업의 파일/원격 이력을 확인한다. 예상 `102_organization_booking_policies.sql`.
- `apps/api/src/modules/booking-policy/{schemas,gateway,routes,policy}.ts` 또는 기존 모듈 안의 동등한 독립 파일로 구성한다. `app.ts`/서버 gateway 등록과 기존 availability reader에 연결한다.
- RPC `get_organization_booking_policy(p_organization_id)` → 정책+주간 구간+차단 목록. `save_organization_booking_policy(p_organization_id,p_expected_version,p_operation_id,p_policy)` → 저장본. 실제 인터페이스의 최종 이름/타입은 보고서에 명시한다.
- React의 기존 예약 페이지 관리자 액션 → `BookingPolicyDialog`와 API helper, 동일 스타일을 재사용한다.

## 집중 수락 테스트

- disabled 기본값 보존, 활성 영업일/점심/닫힘 경계·버퍼 포함, 자정/시간대, 차단 구간 끝·시작 반개구간, 당일 접수 마감/최소 사전 시간.
- 예약 생성/수정과 반복 저장의 DB 우회 거절, 기존 기록 완료·메모·취소는 허용, 정책 변경이 기존 예약을 자동 변경하지 않음.
- 추천과 저장의 동일 입력·결과, 정책 조회 실패 거절, 다른 조직/비회원/member 쓰기 거절, 버전 충돌/동일 operation 재시도.
- UI 저장 실패 입력/권한/취소·DraftBoundary 보호.

전체 테스트/실제 앱/실고객 변경/커밋/푸시 금지. SQL 원격 적용은 주 에이전트가 수행한다. 보고서 경로: `docs/product/audits/2026-10-30-organization-booking-policies.md`. 날짜/명령·결과·외부 미검증 범위·SQL/RPC 계약·변경 파일을 기록하고 마지막 메시지는 짧게 상태와 우려만 반환한다.
