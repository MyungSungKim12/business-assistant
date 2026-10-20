# 노쇼 사유·예약 상태 변경 이력

날짜: 2026-10-19. 기능: APT-003/019, 독립 감사 F13. 상태: in-progress. 선행: 기존 예약 상태 RPC와 SQL 061까지. 사용자는 061 적용을 보고했다. **새 SQL 062는 준비·격리 검증 상태이며 원격 미적용**이다.

## 원인과 변경

034의 `transition_appointment`는 취소 사유만 예약 행에 보존했다. 노쇼는 입력 사유가 멱등 fingerprint에만 쓰여 상세에서 다시 읽을 수 없었다.

- `appointments.no_show_reason`을 취소 사유와 별도로 추가한다. 기존 노쇼는 null을 유지한다. 사유 없는 과거 데이터를 임의로 복구하지 않는다.
- `appointment_status_events`에 변경 전/후 상태, 사유, 변경 시각, 변경자 UUID, 예약 버전과 operation_id를 저장한다. 조직·예약 FK, 허용 전이·사유·버전 제약과 유일 제약을 적용한다.
- 상태 변경 RPC에서 예약 상태·방문/장바구니·이력·멱등 결과를 한 트랜잭션으로 기록한다. 기존 역할·상태 전이·버전 충돌·방문 중복 방지를 유지한다. 같은 요청 재시도는 저장된 결과를 반환하며 이벤트를 다시 만들지 않는다.
- 이력 테이블은 인증 조직 구성원에게 RLS SELECT만 허용한다. 직접 INSERT/UPDATE/DELETE 권한은 주지 않는다. 상태 변경 RPC는 기존 SECURITY DEFINER의 명시 역할 검사와 빈 search_path를 유지하고, 이력 읽기 RPC는 SECURITY INVOKER로 조직·예약 및 RLS를 확인한다.
- API는 task.basic 권한과 조직/예약/중복 ID/버전 순서를 확인한다. operation_id는 이력 조회 응답에 내보내지 않는다.
- 예약 상세에 노쇼 사유와 상태 이력을 연결했다. 조회 실패/SQL 미적용은 빈 이력과 구분하며 재시도와 예약 전환의 늦은 응답 차단을 제공한다. 상태 변경 후 예약 버전이 바뀌면 다시 읽는다. 기존 화면 구성·스타일은 유지했다.

## 업그레이드 중 재시도

독립 리뷰에서 034가 허용한 ‘사유 없는 노쇼’의 성공 요청을 062 이후 재시도하면 새 검증에 걸리는 문제를 지적했다. 이를 수정해 **동일 actor/fingerprint의 기존 성공은 먼저 반환하고, 새로운 노쇼에만 사유 필수를 적용**한다. API도 null/빈 사유를 DB에 전달해 신규 거절과 과거 성공 복구를 DB에서 구분한다. 형식·길이 검증과 인증·권한 검사는 유지한다. 재리뷰에서 해당 지적의 해결을 확인했다.

## 검증

| 명령 | 결과 |
| --- | --- |
| `node scripts/db-tests/appointments.mjs --history` | PASS: 노쇼 사유, 전이 이력, 기존 성공 재시도, 이벤트 중복 방지, 오래된 버전, 직접 DML·익명·조직 경계, 방문 장바구니, 재적용 |
| API `vitest run src/routes/appointmentHistory.test.ts src/routes/appointments.test.ts src/modules/appointment-resources/appointment-resources.test.ts src/modules/appointment-resources/service-staff.test.ts` | 64개 통과 |
| React `vitest run src/features/appointments/AppointmentStatusHistory.test.tsx src/features/appointments/AppointmentPage.test.tsx` | 52개 통과 |
| API `tsc --noEmit`, React `tsc -p tsconfig.app.json --noEmit` | 통과 |

원본 RPC에서 노쇼 사유가 undefined로 돌아오는 실패를 먼저 재현했다. 신규 API·React의 선행 실패 후 구현 통과도 확인했다. 격리 DB에 이벤트 INSERT 실패 트리거를 임시 설치해 상태·방문 생성·멱등 결과가 모두 롤백되는 것을 검증했다. 트리거는 테스트 안에서만 사용한다.

실제 앱 실행·화면 증거·전체 테스트·원격 DB·운영 데이터 변경·커밋/푸시는 하지 않았다. 기능 전체를 verified로 올리지 않는다.

## 적용과 남은 범위

1. 061까지 적용된 DB에서 `migrations/062_appointment_status_history.sql` 전체를 실행한다.
2. 최신 API와 앱을 재시작한다. 062 이전에는 이력 조회 오류 안내가 표시된다.
3. 적용 후 발생한 상태 변경부터 이력이 쌓인다. 062 이전 변경이나 이전 성공 요청 재전송으로 과거 이벤트를 생성하지 않는다.

변경자는 계정 UUID로 표시한다. 계정 표시명 연결은 별도 권한·비활성 계정 표시 정책과 함께 후속이다. 일정·담당자·메모 수정 이력이 아니라 **상태 변경 이력**만 기록한다. 완료/취소/노쇼의 관리자 정정, 예약 슬롯 재점유·수납/회원권 원장 복구, 자동 수수료는 이번 범위가 아니다. 기존 전이 제한을 완화하지 않는다.

다음 우선순위는 F14 직원 정보 수정·담당 중지와 고객 주요 프로필 입력 보완이다.

## 적용 후속 기록

2026-10-19 사용자가 SQL 062 실행 완료를 보고했다. 구현 당시 원격 미적용 기록은 이력으로 보존하며, 독립 원격 확인과 실제 앱 검증은 아직 하지 않았다.
