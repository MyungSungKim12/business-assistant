# SET-002 업무 권한 구현·검증 기록

기록일: 2026-11-03 · 범위: N1030-07, 검증 범위 한정

## 구현

- 구성원 상세에서 업무별 조회/관리·수납·환불 승인·내보내기 권한을 읽고 저장한다. 소유자 권한 변경은 잠겨 있다.
- 권한 저장은 owner만 할 수 있고 변경 항목은 `audit_events`에 기록한다. 저장 성공 시 조직 권한 캐시를 무효화한다. 업무 게이트는 캐시된 기능/역할과 별도로 권한 코드를 매 요청 검사한다.
- 고객·예약·시술·수납·환불 API 경로에 권한 확인을 연결했다. 고객 내보내기는 권한 확인 완료 전 숨기고 실패 시 비활성화한다.
- SQL107은 조직 멤버십에 묶인 override 저장소와 RPC를 추가했다. SQL108은 현재 업무 RLS/RPC가 member 쓰기를 허용하지 않는 영역을 UI/API에서 허용한다고 오인하지 않도록 member의 쓰기 grant를 DB에서도 거부한다. 읽기/내보내기 범위는 owner 정책으로 설정 가능하다.

## 검증 증거

- 격리 DB: `node scripts/db-tests/business-permissions-107.mjs` 통과 (기본 역할, 권한 부여/차단, owner/admin/member/비회원, 조직 경계, 알 수 없는 권한, 감사, 멤버 삭제 cascade 포함).
- API: 구성원 권한 + access-cache + 시술 + 매출 focused tests 24건 통과.
- React: 구성원 권한 UI + 고객 상세/내보내기 focused tests 28건 통과.
- `pnpm api:build`, `pnpm react:build` 통과. Vite 번들 500KB 경고는 기존 번들 분리 필요 항목으로 남는다.
- Supabase 프로젝트 `business-assistant`: SQL107 version `20261102072810`, SQL108 version `20261103000000` 확인. 테이블 RLS 활성, authenticated 직접 SELECT/INSERT 거부, anon setter execute 거부, authenticated setter execute 허용, 적용 setter 본문에서 `role_permission_limit` 확인.
- Supabase Security Advisor에는 RPC 전용 RLS 무정책 INFO 및 SECURITY DEFINER 경고, leaked-password 설정 WARN이 남아 있다. 새 권한 저장소 직접 ACL은 거부되므로 RPC 밖에서 접근할 수 없다.

## 제한 / 다음 범위

- 조직의 owner/admin/member 실계정 조합을 통한 실제 화면 인수는 하지 않았다.
- 모든 화면에서 권한 없는 작업 버튼을 사전 숨기는 UX 확대는 아직 아니다. 해당 API는 거부하지만 호출 전 일관된 disabled/숨김 상태가 고객 내보내기 외 메뉴마다 적용됐는지는 별도 작업이 필요하다.
- 여러 기존 업무 RPC는 SECURITY DEFINER이며 자체 역할·조직 경계를 유지한다. advisor의 133건 전체를 이 기능의 변경 범위로 일괄 조정하지 않았다.
- 이 기록은 구현/격리·원격 스키마 범위 증거이며 전체 앱 인수 또는 운영 권한 정책 인증이 아니다.
