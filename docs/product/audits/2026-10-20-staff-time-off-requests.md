# TEAM-11 직원 계정 연결·휴무 신청·승인

기록일: 2026-10-20

## 범위

- `077_staff_account_link.sql`: 같은 조직의 기존 로그인 계정과 직원 레코드를 1:1 연결하고 해제한다. 계정 연결은 조직 역할 권한을 부여하지 않는다.
- `078_staff_time_off_requests.sql`: 연결된 활성 직원이 휴무를 신청하고, owner/admin이 승인하거나 반려한다. 직원은 대기 신청을 철회할 수 있다.
- 승인 시 기존 `appointment_staff_time_off` 생성 RPC를 호출해 예약 충돌 검사를 재사용한다. 요청 상태 변경과 휴무 생성은 한 트랜잭션이며, 대기 신청은 예약 가용 시간을 차단하지 않는다.
- 요청·승인·반려·철회 이력은 append-only 이벤트에 기록된다. 신청자는 자기 신청만 읽고 철회할 수 있으며 관리자 권한은 조직 membership에서 검사한다.

## 집중 검증

- `npm run test:staff-account --prefix scripts/db-tests`: 통과. 연결·해제, 중복 연결, 역할·조직 경계, 버전 충돌과 재시도를 확인했다.
- `npm run test:staff-leave --prefix scripts/db-tests`: 통과. 신청자 확인, 중복 기간, 승인 후 예약 차단, 반려·철회, 이벤트 보존, 역할·조직 경계와 재시도를 확인했다.
- `pnpm --filter @business-assistant/api test -- src/modules/appointment-resources/appointment-resources.test.ts`: 48개 통과.
- `pnpm --filter @business-assistant/desktop-react test -- appointment-resources.test.tsx`: 25개 통과.
- `pnpm --filter @business-assistant/api build`: 통과.
- `pnpm --filter @business-assistant/desktop-react build`: 통과. Vite의 기존 500KB 초과 청크 안내는 남았다.

## 제한과 적용

- SQL 077·078은 Supabase 실환경 적용 대기다. 적용 순서는 현재 적용된 최신 번호 다음으로 077, 078이며, 이후 API와 앱을 다시 시작한다.
- 직원 본인 로그인 계정이 구성원으로 먼저 초대되어 있어야 연결할 수 있다. 계정별 자기 급여/수당 명세와 확정·조정 원장은 구현 범위가 아니다.
- 실 Supabase 왕복, 동시 승인 운영, Tauri 패키지 실행 검증은 하지 않았다.

## 다음 작업

수당 수납 배분 기준을 할인·복합 결제·환불까지 정식화하고, 거래 라인별 수당 계산 근거·확정/조정 원장·직원별 열람 권한을 설계한다. TEAM-11은 그 작업까지 완료 전 상태다.
