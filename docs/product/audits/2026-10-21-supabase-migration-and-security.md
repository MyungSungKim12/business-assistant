# Supabase migration 066~099 및 보안 점검 — 2026-10-21

## 확인 범위

- 프로젝트: `business-assistant` (`rtmcrptkzcauzrwcfbph`)
- Supabase migration history에서 066~099 적용을 확인했다. 098 결과는 `20261021061711`, 099는 `20261021062741`로 등록됐다.
- 사용자가 적용을 마쳤다고 보고한 065 이후를 원격 이력으로 이어서 확인한 것이다. 아래 결과는 전체 앱의 운영 인수나 모든 업무 흐름 테스트를 뜻하지 않는다.

## 데이터 및 정책 점검

- 상품 재고 수량과 로트 잔량 대조 결과 차이 0건.
- 고객 테이블의 `anon`/`authenticated` 직접 DELETE 권한이 없음을 확인했다. CRM-014 097은 보유 정책·관계 종료·법적 보류 기반만 제공하며 고객 데이터를 지우지 않는다.
- 098 이전 Security Advisor는 RLS 정책 없는 테이블 9개, `anon`의 SECURITY DEFINER 실행 1개, `authenticated` 실행 120개, leaked-password protection 비활성 1개를 보고했다.

## SECURITY DEFINER 권한 테스트 및 099 보완

- 공개 `authenticated` 실행 SECURITY DEFINER RPC 119개의 실제 정의를 재점검했다. 전부 `search_path = ''`로 고정되어 있고 동적 SQL 호출은 없었다. 109개는 인증/조직 검사 문자열이 직접 확인됐으며 나머지는 `private.assert_appointment_role`, 검사된 public RPC 위임, 또는 별도 인증 검사를 사용한다.
- 099 이전 함수 `organization_exists(uuid)`는 로그인만 확인하고 임의 UUID가 실제 조직인지 반환해 조직 존재 여부를 노출할 수 있었다. API의 일반 권한 흐름에서 실행해 확인한 뒤, SQL 099로 현재 사용자의 `memberships`에 해당 조직이 있는 경우에만 `true`가 되도록 수정했다. 앱 역할의 권한은 authenticated에만 유지하고 `PUBLIC`/anon 권한은 제거했다. API도 접근 불가 조직에 대해 404 대신 일반 권한 거부 403을 반환한다.
- 원격 적용: migration `099_scope_organization_existence_to_membership` (`20261021062741`). 확인된 owner는 소속 조직에서 `true`, 임의의 존재하지 않는 UUID에서 `false`를 받았다. 합성 비회원 subject로 실제 조직 UUID를 검사했을 때도 `false`였다. owner의 읽기 전용 `list_organization_branches` 호출은 배열 결과를 반환했다.
- 합성 비회원 subject와 실제 조직 UUID를 사용한 롤백 테스트에서 조직 범위가 있는 SECURITY DEFINER RPC 117개가 모두 `42501`로 거부됐다. JWT 없는 authenticated 호출에서는 공개 RPC 119개 전부 거부됐다(118개 `42501`, 조직 생성 함수 1개는 인증 오류 `P0001`). 호출은 모두 한 트랜잭션 안에서 실행 후 롤백했다. 실제 JWT 서명 검증이나 전체 사용자 동선은 이 SQL 시험에 포함되지 않았다.
- 같은 사용자/조직을 사용하되 멤버십 역할을 트랜잭션 안에서만 `member`와 `admin`으로 바꿔 역할 경계를 확인했다. member는 지점 목록 읽기가 허용되고 구성원 개인정보 목록은 `42501`로 거부됐다. admin은 구성원 목록 RPC가 허용됐다. owner의 정상 읽기 RPC도 허용됐다. 변경은 모두 rollback되어 실제 멤버십에는 남지 않았다.
- Supabase Advisor는 SECURITY DEFINER 호출 가능성 lint를 함수 코드 의미와 관계없이 계속 119건 표시한다. DB의 비로그인·비회원 및 일부 member/admin 권한 경계는 확인했지만, API의 실제 JWT와 유효한 업무 데이터 기반 전체 정상 동선 인수는 남아 있다. 현재 프로젝트에는 owner 1명·조직 1개만 있어 실제 다중 조직 계정 간 비교 테스트는 불가능하다.

## 098 조치와 검증

- `public.rls_auto_enable()`에서 `PUBLIC`, `anon`, `authenticated`의 EXECUTE 권한을 회수했다. postgres 실행 권한과 `ensure_rls` event trigger는 유지된다.
- RPC 경유 테이블 8개와 private 내부 작업 테이블 1개에 anon/authenticated `FOR ALL` 차단 정책을 추가했다. 앱 역할의 테이블 직접 권한은 이미 없었으며, 정책은 추가 방어층이다.
- 직접 권한 조회에서 anon/authenticated 실행 권한 없음, postgres 실행 권한 있음, event trigger 활성 상태를 확인했다.
- 일시 생성한 테스트 테이블을 통해 앱 역할의 함수 실행 권한 회수 뒤에도 event trigger의 자동 RLS 활성화가 성공하는지 확인하고 테스트 테이블을 제거했다.
- 적용 후 Security Advisor는 RLS-without-policy와 anon SECURITY DEFINER 경고를 더 이상 표시하지 않았다.

## 남은 보안 항목

- Advisor가 `authenticated_security_definer_function_executable` 119건을 계속 보고한다. 이는 클라이언트에서 호출 가능한 SECURITY DEFINER 함수에 대한 일반 경고다. 정적 권한 흐름 점검에서 인증/조직 범위 검증을 하거나, 이미 보호된 내부 함수로 위임하는 경로를 확인했다. 공개 실행 함수 하나를 회수했고, 나머지를 blanket revoke하면 정상적인 서버/RPC 쓰기 기능이 깨질 수 있어 일괄 차단하지 않았다. 역할별 우회/교차 조직 동적 테스트는 전체 인수 단계에서 남아 있다.
- `auth_leaked_password_protection`은 현재 Supabase Free 요금제에서 설정을 켤 수 없어 남는다. Supabase 문서상 이 기능은 Pro 이상 요금제에서 제공된다. 요금제 변경과 설정은 이번 작업 범위에 포함되지 않았다.
- 098로 해결된 경고 수와 남은 항목은 작업 시점의 advisor snapshot이며, 이후 함수/권한 변경이나 플랜 변경 뒤 다시 확인해야 한다.

## 다음 단계

1. 실제 API bearer token과 유효한 업무 자료를 사용해 로그인·조직·역할별 인수를 진행하고, 다른 조직 계정을 추가한 뒤 교차 조직 검사를 보완한다. SQL 수준의 unauthenticated·non-member·member/admin 제한 smoke test는 완료했다.
2. Supabase 요금제 변경을 결정한 뒤 Auth 설정에서 leaked-password protection을 켜고 advisor를 재확인한다.
3. 기능별 실제 업무 흐름과 설치 앱 인수는 별도 전체 테스트 단계에서 수행한다.

## 참고

- [Supabase RLS 가이드](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase 함수 실행 권한 안내](https://supabase.com/docs/guides/troubleshooting/how-can-i-revoke-execution-of-a-postgresql-function-2GYb0A)
- [Supabase 비밀번호 보안](https://supabase.com/docs/guides/auth/password-security)
