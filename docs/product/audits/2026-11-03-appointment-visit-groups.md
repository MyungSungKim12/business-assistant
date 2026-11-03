# N1030-09 / APT-021 복수 시술 방문 예약

기준일: 2026-11-03  
상태: 코드·원격 SQL 검증 범위에서 verified. 실제 Tauri 화면을 이용한 예약부터 체크인·시술·수납까지의 업무 인수는 남아 있다.

## 범위와 선행 조건

- N1030-09, 메뉴 기능 APT-021. 기존 예약·직원/서비스/지점/공간/장비·상태 이력·예약 정책을 재사용한다.
- 한 고객 방문에 2~8개 시술을 순서대로 등록한다. 각 구간에 담당자와 필요한 공간/장비를 지정하고 서비스 소요 시간과 준비 여유를 반영한다.
- 편집·취소·확정·방문·완료·노쇼를 묶음 단위로 처리하며, 작업 식별자와 그룹 버전으로 중복 실행 및 오래된 편집을 막는다.
- 기존 예약은 미그룹 예약으로 유지한다. 그들의 시간·상태 값은 이 migration에서 변환하지 않는다.

## 구현 결과

- SQL110은 예약 묶음, 순서, 현재 회차/수정 버전을 추가한다. 각 시술 구간은 기존 예약 행으로 저장하여 기존 직원·공간·장비 점유 충돌 검사를 재사용한다.
- 예약 그룹 변경은 전체 회차를 한 트랜잭션에서 교체하고, 상태 변경/취소도 모든 현재 구간에 원자 반영한다. 단일 구간의 직접 수정·취소는 DB에서 거부한다.
- 체크인할 때 복수 구간이어도 고객 방문과 수납 카트는 하나만 생성한다. 결제/시술의 확정 실적은 기존 개별 업무 원장을 계속 사용한다.
- React 예약 화면에 묶음 생성·수정, 서비스 순서/담당자/자원 선택, 예상 시간 계산, 취소 확인, 전체 상태 변경을 연결했다. 기존 예약 상세·목록·일/주 달력에서 그룹 순서를 알 수 있다.
- 묶음 자원 선택은 예약 화면이 이미 읽은 지점 자원 목록을 공유해 시술마다 자원 목록을 중복 조회하지 않는다. 자원 로드 실패 시 단독 조회로 재시도할 수 있다.

## 검증 증거

- `node scripts/db-tests/appointment-visit-groups-110.mjs` — 격리 PGlite에서 생성·멱등 재시도·교차 조직·담당자 자격/지점·예약 충돌 롤백·단독 구간 변경 차단·묶음 교체/취소·체크인 카트 중복 방지·완료/노쇼·RLS/권한 테스트 통과.
- `pnpm --dir apps/api exec vitest run src/modules/appointment-visit-groups/routes.test.ts src/routes/appointmentHistory.test.ts` — 13 tests 통과.
- `pnpm --dir apps/desktop-react exec vitest run src/features/appointment-resources/appointment-resources.test.tsx src/features/appointments/AppointmentVisitGroupDialog.test.tsx src/features/appointments/visitGroupSchedule.test.ts src/features/appointments/AppointmentPage.test.tsx` — 87 tests 통과.
- `pnpm api:build`, `pnpm react:build` — 통과. React 빌드에서 기존 대형 번들 경고가 출력된다.
- Supabase migration `appointment_visit_groups`, 원격 version `20261103004028` 적용과 migration history 등재를 확인했다.
- 적용 전후 기존 예약 23건·고객 19명 유지. 현재 묶음 0건. 새 묶음 테이블 RLS 활성화, anon/authenticated 직접 테이블 ACL 없음, 4개 묶음 RPC는 authenticated만 실행 가능하고 anon/public은 불가.

## 한계와 다음 확인

- 실 Tauri 앱에서 묶음 생성/수정/충돌·취소 확인과 체크인 후 단일 방문·카트 연결을 인수하지 않았다. 여러 담당자가 이어서 진행하는 실제 업무 흐름과 화면 정보량 확인도 남아 있다.
- 기존 여러 개의 독립 예약을 자동으로 하나의 그룹으로 합치지 않는다.
- 결제·시술 기록은 별도 원장을 사용한다. 묶음 예약 한 건만으로 매출이나 시술 완료가 만들어지지 않는다.
- 실 Supabase 원격 함수 호출을 통한 사용자 세션·실제 시점 동시예약은 별도 인수이며, SQL 동작은 격리 DB 검증과 원격 스키마/권한 확인까지다.

