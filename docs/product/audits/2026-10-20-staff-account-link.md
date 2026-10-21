# TEAM-11 직원 계정 연결 기반

## 구현 범위

- SQL 077은 `appointment_staff.auth_user_id`에 같은 조직의 기존 `memberships` 사용자만 연결할 수 있게 한다. 조직 안에서 사용자 계정은 최대 한 직원 레코드에만 연결된다.
- 연결·해제는 owner/admin RPC로 수행하고, 직원 프로필 버전과 operation ID를 검사한다. 동일 operation 재시도는 저장된 결과를 반환한다.
- 직원 정보 수정 화면에 조직 구성원 선택을 추가했다. 이미 다른 직원에게 연결된 계정은 선택 목록에서 제외하며, 직원 프로필 저장과 계정 연결은 각각 분리해 저장한다.
- 이 연결은 권한을 부여하지 않는다. 조직 역할은 기존 membership 정보만으로 결정한다.

## 검증

- `node scripts/db-tests/appointments.mjs --staff-account`: 통과. 연결·멱등 재시도·버전 충돌·중복 연결·비구성원·member/타 조직/anon 거절·해제를 검사했다.
- `pnpm --filter @business-assistant/api test -- src/modules/appointment-resources/appointment-resources.test.ts`: 46 tests 통과.
- `pnpm --filter @business-assistant/desktop-react test -- StaffProfileDialog.test.tsx`: 4 tests 통과.
- API 및 React 빌드 통과. React 번들 500KB 초과 경고는 이전과 같이 남아 있다.
- 실 Supabase와 Windows 앱 화면은 확인하지 않았다.

## 적용과 제한

- `077_staff_account_link.sql`은 076 이후 순서대로 실행해야 한다. 현재 SQL 066~077은 Supabase 미적용 상태다.
- 직원 계정 연결은 완료됐지만, 직원 본인의 휴무 신청/철회와 관리자 승인·반려 흐름은 아직 없다. 승인된 휴무만 예약 가용성에 반영되도록 다음 TEAM-11 범위에서 연결한다.

## 후속 정정 — 휴무 흐름 구현

위 제한은 계정 연결 단계 기록이다. 휴무 신청·철회·승인/반려 및 승인 휴무의 예약 차단은 이어서 구현했다. 현재 범위와 검증은 [휴무 신청·승인 감사 기록](2026-10-20-staff-time-off-requests.md)을 따른다.
