# 예약 가능 시간 조회 묶음화·충돌 입력 완전성

날짜: 2026-10-20. 기능: APT-015 / APT-12, 독립 감사 F16. 상태 in-progress. 2026-10-19에 시작한 구현의 집중 검증과 문서화를 마무리했다. 선행: 기존 가용 시간 계산 API, 직원/근무/휴무/예약/자원 원장, 공통 Rest.selectAll. **추가 SQL 없음.** SQL 063까지 사용자 적용 보고 상태는 유지한다.

## 원인과 변경

기존 API는 직원마다 직원 행·근무시간·휴무를 다시 읽었다. 모의 HTTP에서 직원 10명이면 데이터 요청 37회가 발생하는 것을 재현했다. 인증·기능 권한 조회는 이 수치에 포함하지 않는다.

- 담당자 UUID 50명씩 근무·휴무를 묶어서 읽는다. 활성·서비스 담당 제한을 통과한 직원만 요청하며, 직원 재조회는 없앴다. 10명 기준 9회, 100명 기준 11회로 확인했다. 테이블 한 페이지 안에 들어오는 테스트 데이터 기준이며 페이지가 추가되면 호출 수도 늘어난다.
- 근무시간은 모든 요일·시간대 행을 유지한다. active 휴무는 선택일 KST 0시~다다음날 0시에 겹치는 범위만 읽어 다른 시간대 근무에서 자정을 넘는 후보도 반영한다.
- 예약 충돌 입력은 전날~다음날 시작 예약을 읽는다. 전날 여유 시간뿐 아니라 다음날 0시 예약과의 충돌도 놓치지 않는다. 실제 예약 저장의 최종 충돌 검사는 기존 DB 로직을 유지한다.
- 묶음 응답은 조직·직원 ID·중복·휴무 status/범위·정확한 count/페이지 범위를 검증한다. 실패를 ‘근무시간 제한 없음’으로 바꾸지 않는다.
- 독립 리뷰에서 기존 listAll이 짧은 페이지를 끝으로 처리해 충돌 예약을 놓칠 수 있음을 확인했다. 공통 Rest.selectAll로 교체해 예약·직원·서비스·자원·필수 자원 및 근무/휴무의 id 기반 목록을 끝까지 읽고 건수를 대조한다.
- 클라이언트 조건 변경은 250ms 동안 묶어 마지막 입력만 조회한다. 조직·서비스·날짜·직원·자원·수정 제외 예약이 바뀌면 이전 결과를 즉시 숨기고 늦은 응답을 버린다. 서버의 서비스/날짜가 요청과 다르면 표시하지 않는다.
- 같은 조건을 ‘가능 시간 다시 확인’으로 새로 읽을 수 있다. 캐시는 추가하지 않았다. 화면 구성과 슬롯 선택·불가 사유 표시는 유지한다.

## 검증 증거

| 명령 | 결과 |
| --- | --- |
| API `vitest run src/modules/appointment-resources/availabilityBatch.test.ts src/modules/appointment-resources/availability.test.ts src/modules/appointment-resources/service-staff.test.ts src/modules/appointment-resources/appointment-resources.test.ts src/modules/appointment-resources/appointment-resources.services.test.ts src/modules/appointment-resources/staffProfile.test.ts` | 91개 통과 |
| React `vitest run src/features/appointments/AvailabilityDebounce.test.tsx src/features/appointments/AvailabilityChips.test.tsx src/features/appointments/AppointmentFormAvailability.test.tsx src/features/appointments/availability.test.ts src/features/appointments/AppointmentPage.test.tsx` | 69개 통과 |
| API `tsc --noEmit`, React `tsc -p tsconfig.app.json --noEmit` | 통과 |

직원 10명의 기존 37회 호출, 100명의 직원별 100회 근무 조회를 선행 실패로 확인했다. 입력 debounce도 기존 3회 요청→최종 1회 요청을 검증했다. 작은 서버 페이지에서 뒤쪽의 confirmed 예약이 누락돼 ‘09:00 가능’으로 잘못 나오는 실패를 재현한 뒤, 모든 페이지를 읽어 불가로 표시하는 회귀를 통과했다.

다른 조직·직원 혼입, 취소 휴무 혼입, count 누락, 서버 실패, 자정 이후 휴무/예약, 담당 지정, 과도한/중복 직원 ID, 인증·기능 권한 거절, 늦은 응답·재시도·서버 응답 조건 불일치를 포함한다. 이전에 끝나지 않았던 React 검사는 테스트에서 API 객체를 매 렌더 새로 생성하던 설정을 정리한 뒤 다시 실행해 종료 코드 0을 확인했다.

독립 리뷰의 잘린 충돌 데이터 지적을 수정·재확인했다. 실제 앱 실행·화면 증거·운영 API/DB·전체 테스트·커밋/푸시는 하지 않았다. 실제 초 단위 성능은 측정하지 않았으므로 화면 로딩 시간이 몇 배 빨라졌다고 보증하지 않는다. 전체 기능 verified 표시는 하지 않는다.

## 반영과 남은 범위

최신 API와 React 앱을 재시작/재빌드하면 적용된다. SQL 실행은 없다.

- 동시 근무 조회 대상은 최대 2,000명이다. 이를 넘는 조직은 담당자를 지정해 조회해야 한다. 묶음은 순서대로 처리하고 각 묶음 안의 근무/휴무 2개만 병렬로 읽는다.
- 공통 완전 조회는 테이블당 20,000행·100페이지·30초 한계가 있으며 넘으면 일부 결과 대신 오류다. 정확한 count를 제공하지 않는 프록시/DB 응답도 오류다.
- 여러 HTTP 조회가 하나의 DB 스냅샷은 아니다. count/중복 이상은 거절하지만 동일 건수의 동시 변경까지 전부 탐지하지는 못한다. 안내 결과는 저장 시점의 슬롯 보장을 대신하지 않는다.
- 캐시가 없다는 것은 조회할 때 다시 읽는다는 뜻이다. 다른 PC가 변경해도 현재 열린 칩이 자동 갱신되지는 않는다. 조건을 바꾸거나 다시 확인 버튼으로 최신 정보를 읽는다.
- cleanup은 아직 전송되지 않은 debounce 타이머를 취소하고 이미 보낸 요청 결과를 무시한다. Native IPC의 실제 네트워크 취소는 추가하지 않았다.
- 서비스 담당 매핑의 기존 최대 100명 설정 계약과 별도 조회는 유지한다. 모든 제품 목록을 한 묶음 RPC나 서버 커서로 전환한 것은 아니다.

다음은 남은 업무 연결 중 시술 시작 전 고객 주의사항·동의 증빙 안내를 점검한다. 실사용·배포 인수는 기존 요청대로 후속으로 유지한다.
