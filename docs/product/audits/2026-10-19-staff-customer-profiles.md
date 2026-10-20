# 직원 예약 담당 수명주기·고객 주요 프로필

날짜: 2026-10-19. 기능: TEAM-001 / CRM-001, 독립 감사 F14. 상태: in-progress. 사용자 SQL 062 적용 완료 보고를 기록했다. **063은 준비·격리 검증 상태로 원격 미적용**이다.

## 구현

- 직원관리에서 선택한 담당자의 이름과 예약 담당 사용 여부를 수정한다. owner/admin의 task.basic 쓰기 권한을 API와 SQL에서 확인한다. 조회 구성원에게는 수정 동작을 제공하지 않는다.
- 예약 담당 중지는 직원 삭제나 로그인 권한 해지가 아니다. 과거 예약·시술·근무 설정은 보존한다. 예약 담당 필터에서 중지 담당자는 기존 활성 필터에 따라 제외된다. 이름 조회용 직원 목록은 따로 보존해 중지 담당의 기존 예약 상세·목록에도 이름을 표시한다. 일 달력의 기존 비활성 담당 그룹도 유지한다.
- 미래에 끝나는 예약/확정 예약 또는 시간과 무관한 진행 중 방문이 있으면 중지를 거절한다. 사용자가 예약 화면에서 재배정하거나 방문을 처리한 뒤 다시 시도해야 한다. 자동 재배정·취소는 하지 않는다.
- SQL 063의 profile_version은 근무표 schedule_version과 분리했다. 조직·행 ID·버전·operation_id를 검증하고 같은 요청 재시도는 같은 결과를 돌려준다.
- 기존 예약 저장은 활성 여부를 잠금 전에 읽으므로, 배정/시간/상태 INSERT·UPDATE 트리거에서 동일 담당자 advisory lock을 획득한 뒤 활성 상태를 다시 확인한다. 중지 이후 과거 예약을 방문 처리하는 경로도 차단한다. 이때 생성하던 방문·장바구니도 롤백된다.
- 수정 실패 시 이름/활성 입력과 같은 요청 ID를 보존한다. 중지 확인, 작성 중 이탈 보호, 확인 중 중복 저장 방지, 충돌 안내를 연결했다. profile_version이 없는 구버전 응답에서는 저장을 비활성화하고 063 적용·목록 갱신을 안내한다.
- 고객 폼에 생년월일, 피부 타입, 관심 항목, 알레르기·주의사항을 추가했다. 관심 항목은 쉼표 입력을 보존하면서 저장 값의 중복을 제거한다. 읽기 전용·저장 실패 입력 유지·기존 고객 전환 보호는 유지한다.
- API 날짜 입력은 ISO date/null로 검증한다. 생년월일과 기존 수기 최근/다음 방문 날짜의 잘못된 날짜를 저장하지 않는다. 기존 수기 날짜를 실제 방문 지표로 바꾸지 않는다.

## 검증

| 명령 | 결과 |
| --- | --- |
| `node scripts/db-tests/appointments.mjs --history --staff-profile` | PASS: 062 회귀와 063 이름/버전/멱등/역할, 미래 예약·진행 방문 중지 거절, 중지 후 배정·지난 예약 방문 거절, 이력 보존·재활성화·재실행 |
| API `vitest run src/routes/customerProfile.test.ts src/routes/customers.test.ts src/modules/appointment-resources/staffProfile.test.ts src/modules/appointment-resources/appointment-resources.test.ts` | 63개 통과 |
| React `vitest run src/features/catalog/StaffProfileDialog.test.tsx src/features/catalog/StaffPage.test.tsx src/features/customers/CustomerFormProfile.test.tsx src/features/customers/CustomerPage.test.tsx src/features/customers/CustomerPageTools.test.tsx src/features/appointments/AppointmentPage.test.tsx` | 81개 통과 |
| API `tsc --noEmit`, React `tsc -p tsconfig.app.json --noEmit` | 통과 |

필드/라우트 미존재 선행 실패 후 구현 통과를 확인했다. 독립 리뷰가 과거 예약의 상태만 바꾸는 방문 처리 누락을 지적했으며, DB에서 ‘예상한 거절 없음’을 재현했다. status UPDATE도 잠금/활성 검증에 포함한 뒤 방문이 생성되지 않는 회귀 검증과 재리뷰를 통과했다.

실제 앱 실행·화면 증거·전체 테스트·운영 DB·커밋/푸시 없음. 잠금 보완은 소스와 단일 격리 DB 순차 회귀로 확인했으며 다중 세션 경합 부하 검증은 하지 않았다. 전체 기능 verified 표시는 하지 않는다.

## 적용·제한·후속

1. 062까지 적용한 DB에서 `migrations/063_staff_profile_lifecycle.sql` 전체 실행 후 API·앱을 재시작한다.
2. 직원 정보 수정에서 이름/담당 사용을 관리한다. 409 안내가 나오면 남은 예약·방문을 처리하거나 창을 닫았다 다시 열어 최신 버전을 확인한다.

직원 프로필의 operation_id는 열린 팝업의 같은 입력 재시도에 보존한다. 팝업 종료·재시작 이후에는 최신 목록을 읽고 새 버전으로 처리하며 금융 요청처럼 영속 요청 큐를 두지 않았다. 이전 결과 확인 전 입력을 바꾸어도 버전 검증이 중복 변경을 차단한다.

직원과 로그인 구성원 연결, 퇴사 정산, 자동 재배정, 미래 예약을 한 번에 옮기는 화면은 후속이다. 고객 알레르기 입력은 의료 판정이나 자동 시술 적합성 평가가 아니다. 시술 시작 화면의 별도 주의사항 경고·동의 점검은 추가 범위로 남는다. 날짜 필드는 과거에 형식이 잘못 저장된 값을 자동 보정하지 않으며 해당 고객을 수정할 때 올바른 날짜로 정리해야 한다.

다음 감사 우선순위는 F15 Native HTTP 전체 요청 시간 제한과 미확인 쓰기 결과 처리다.

## 적용 후속 기록

2026-10-19 사용자가 SQL 063 실행 완료를 보고했다. 구현 당시 원격 미적용 기록은 이력으로 보존한다. 독립 원격 확인과 실제 앱 검증은 수행하지 않았다.
