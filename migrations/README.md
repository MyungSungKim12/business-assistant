# 인증·조직·구독 마이그레이션

이 디렉터리의 SQL은 Supabase PostgreSQL에 인증, 조직 멤버십, 상품, 구독 권한의
기본 구조를 추가합니다. 적용 순서는 다음과 같습니다.

1. `001_auth_entitlements.sql`로 테이블, 인덱스, RLS 정책을 적용합니다.
2. `002_seed_entitlements.sql`로 BASIC, STANDARD, PRO 상품과 기본 기능 코드를
   멱등하게 등록합니다.
3. `003_subscription_and_organization_hardening.sql`로 활성 구독 중복을 막고,
   사용자 JWT만으로 조직 존재 여부를 확인하는 제한된 RPC를 추가합니다.
4. `004_admin_subscription_rpc.sql`로 플랫폼 관리자 전용의 원자적 구독 교체 RPC를
   추가합니다.
5. `005_crm_customers.sql`로 조직별 고객 데이터를 만들고 멤버 조회와 관리자 변경 RLS를
   적용합니다.
6. `006_tasks.sql`로 조직별 작업과 일정 데이터를 만들고 생성자/관리자 변경 RLS를 적용합니다.
7. `007_documents.sql`로 조직별 문서 템플릿과 문서 데이터를 적용합니다.
8. `008_finance_transactions.sql`로 수입·지출 원장과 기간 집계를 적용합니다.
9. `009_file_assets.sql`로 조직별 파일 메타데이터와 비공개 Storage 버킷/RLS를 적용합니다.
10. `010_authenticated_grants.sql`로 Supabase Data API의 `authenticated` 역할에 테이블 권한을 부여합니다. 실제 행 접근은 각 테이블의 RLS가 계속 제한합니다.
11. `011_organization_insert_policy.sql`로 로그인 사용자의 조직 생성 INSERT 정책을 보정합니다. 생성자는 DB 트리거를 통해 owner로 등록됩니다.

적용 전에는 대상 Supabase 프로젝트의 마이그레이션 환경에서 실행하는지 확인합니다.
연결 문자열과 서버 전용 비밀값은 로컬 `.env`에만 보관하고, 데스크톱 앱이나 Git에
저장하지 않습니다.

모든 `public` 애플리케이션 테이블은 RLS를 사용합니다. 멤버십 기반 RLS 조회는
`private.has_organization_role` 함수를 통해 수행해 멤버십 테이블 정책의 재귀를
피합니다. 이 함수는 호출자의 `auth.uid()`와 역할을 직접 확인하며, `authenticated`
역할에만 실행 권한을 부여합니다.

기본 상품 데이터와 스키마는 결제 연동을 포함하지 않습니다. 활성 구독은
`trialing` 또는 `active` 상태이고, `ends_at`이 비어 있거나 미래인 경우로 서버
서비스 계층에서 판정합니다.
