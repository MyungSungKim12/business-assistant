# APT-13 예약 대기 목록 구현 계획

## 범위
직원용 대기 신청 등록·조회·상태 관리와 대기 건에서 실제 예약으로의 원자 변환. 내부 대기 목록만 제공하며 반복 예약, 문자 발송, 온라인 예약은 제외한다. 고객/서비스/담당자/조직 경계를 서버와 DB에서 검증한다.

## 제약과 검토 초점
기존 appointment-resources 구조와 API 접근권한(task.basic)을 재사용한다. 대기 상태는 waiting/contacted/booked/canceled이며 상태 변경에 낙관적 버전을 적용한다. 등록과 예약 변환은 operation_id 및 입력 fingerprint로 재시도 안전성을 보장한다. 대기 행 잠금 아래 예약 저장과 상태 변경을 같은 DB 트랜잭션에서 처리한다. 외부 발송과 반복 규칙은 제외한다.

## 작업 순서 (TDD)
1. 대기 목록 SQL 계약과 API 테스트로 조직 격리, 고객/서비스 FK, 상태 전이, 버전 충돌, 권한/직접쓰기 차단을 검증한다.
2. `apps/api/src/routes/appointments.test.ts`에 목록·생성·상태 갱신·입력 거부·조직/권한 경계 테스트를 추가하고 실패를 확인한다.
3. migration 056에 대기 테이블을 추가하고 migration 059에 멱등 등록·상태 RPC·원자 예약 변환을 추가한다.
4. AppointmentGateway와 API routes를 확장하고 API 테스트를 통과시킨다.
5. 예약 화면에 대기 목록 패널과 등록/상태 변경 동선을 추가하고 React 테스트로 권한·오류·빈 상태를 확인한다.
6. backlog, 예약 상세 문서, changelog, migrations README를 실제 검증 범위대로 갱신한다.

## 완료 조건
API 및 화면의 집중 테스트와 SQL 계약 검증이 완료되고, 실제 Supabase SQL 059 적용·실계정 예약 흐름 검증 상태를 별도 기록한다.
