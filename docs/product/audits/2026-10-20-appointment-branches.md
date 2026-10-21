# APT-20 지점 범위 기반

기록일: 2026-10-20 · 상태: in-progress · Supabase 적용 전

## 범위

- `073_organization_branches.sql`: 지점 테이블·조직별 본점 생성·멤버 조회 및 관리자 생성 RPC.
- `074_appointment_branch_scope.sql`: 기존 직원·공간·장비·예약의 지점을 본점으로 채우고 조직 복합 외래 키를 둔다. 새 직원·자원은 기본 지점에 배치하고 예약은 담당자 지점을 따른다. 예약 자원은 같은 지점에서만 충돌 검사한다.
- API 지점 조회와 예약 화면의 지점/담당자 필터를 추가했다. 관리자 지점 관리 화면에서 지점 생성과 담당자·공간·장비 이동을 할 수 있고, 예약 작성은 선택한 지점의 직원/자원을 사용한다.

## 보안·전환 규칙

- 지점 조회는 조직 구성원, 지점 생성·직원/자원 이동은 owner/admin만 허용한다. 일반 테이블 직접 쓰기는 막고 RPC에서 조직·역할·활성 상태를 검사한다.
- 예정된 활성 예약이 남은 직원·자원 이동은 거절한다. 예약 지점은 담당자 지점과 일치해야 한다.
- 과거 기록은 본점에 귀속한다. 이 초기 배치는 마이그레이션에 기록되며, 조직의 기존 지점 의미를 추정하지 않는다.

## 검증

- `npm run test:appointment-branches --prefix scripts/db-tests`: 073~074 재적용, 기본 지점, 조직 경계, 지점 이동, 예약 자동 귀속 통과.
- `pnpm --filter @business-assistant/api test -- appointment-resources.test.ts`: 45개 통과(지점 조회/생성/이동 권한 포함).
- `pnpm --filter @business-assistant/desktop-react test -- appointment-resources.test.tsx`: 24개 통과(지점 생성 및 담당자/자원 배정 화면 포함).
- `pnpm --filter @business-assistant/desktop-react test -- AppointmentPage.test.tsx`: 51개 통과.
- API·React 빌드 통과. 전체 테스트/실 Supabase/Windows 창 확인은 하지 않았다.

## 남은 범위

SQL은 Supabase에 적용하지 않았다. 서비스·상품을 공유하면서 지점별 재고를 나눌지 여부, 기존 데이터의 실제 지점 이관 검토, 다른 지점 예약 조회 권한, 실환경 인수가 남았다. SQL 073 → 074 순으로 적용하고 API와 앱을 다시 시작해야 한다.
