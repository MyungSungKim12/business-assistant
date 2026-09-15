# 인증·조직·구독 권한 설계

## 목표

Supabase Auth로 사용자 세션을 관리하고, FastAPI가 사용자·조직·구독 상태를 확인해 데스크톱 앱에 허용된 기능 코드 목록을 제공한다. 첫 단계에서는 결제 연동 없이 관리자가 구독을 지정할 수 있도록 하며, 이후 결제 웹훅을 같은 구독 모델에 연결한다.

## 범위

포함:

- Supabase Auth 기반 이메일 로그인과 회원가입
- 사용자 프로필과 조직 생성
- 조직 멤버십 및 `owner`, `admin`, `member` 역할
- 구독 상품과 기능 코드의 관계
- 조직의 활성 구독 및 기능 목록 조회
- FastAPI의 인증·조직·기능 권한 검사
- 데스크톱 메뉴의 기능 코드 기반 활성화
- 테넌트 분리와 RLS를 고려한 데이터베이스 설계

제외:

- 실제 카드 결제와 자동 결제
- 소셜 로그인 제공자 설정
- 비밀번호 재설정 UI의 상세 화면
- 업종별 업무 모듈

## 아키텍처

```text
PySide6 Desktop
  └─ Supabase Auth 로그인 → access token
       └─ HTTPS Bearer token
            ↓
FastAPI
  ├─ AuthPort: 토큰 검증과 현재 사용자 확인
  ├─ OrganizationService: 조직과 멤버십 조회
  ├─ EntitlementService: 구독에서 기능 코드 계산
  └─ 보호된 API: 기능 코드 검사
       ↓
Supabase Auth + PostgreSQL
```

데스크톱 앱은 Supabase 데이터베이스에 직접 연결하지 않는다. 앱은 인증 토큰을 FastAPI에 전달하고, 서버는 매 보호 요청에서 사용자와 조직 권한을 검증한다. 메뉴를 숨기거나 비활성화하는 동작은 사용자 경험을 위한 것이며, 보안 경계는 FastAPI와 데이터베이스 RLS에 둔다.

## 데이터 모델

모든 식별자는 `uuid`를 사용하고, 시간은 `timestamptz`로 저장한다. 외래 키 컬럼에는 인덱스를 추가한다.

### `profiles`

- `id uuid primary key references auth.users(id) on delete cascade`
- `display_name text not null default ''`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

사용자 권한을 `user_metadata`에 저장하지 않는다. 조직 역할과 구독 권한은 애플리케이션 테이블에서 관리한다.

### `organizations`

- `id uuid primary key default gen_random_uuid()`
- `name text not null`
- `slug text not null unique`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

### `memberships`

- `id uuid primary key default gen_random_uuid()`
- `organization_id uuid not null references organizations(id) on delete cascade`
- `user_id uuid not null references auth.users(id) on delete cascade`
- `role text not null check (role in ('owner', 'admin', 'member'))`
- `created_at timestamptz not null default now()`
- unique `(organization_id, user_id)`

`organization_id`, `user_id`에 인덱스를 둔다. RLS 정책은 `(select auth.uid())` 패턴과 멤버십 존재 확인을 사용한다.

### `features`

- `code text primary key`
- `name text not null`
- `description text not null default ''`
- `created_at timestamptz not null default now()`

예: `dashboard.basic`, `crm.basic`, `reports.basic`.

### `plans`

- `id uuid primary key default gen_random_uuid()`
- `code text not null unique`
- `name text not null`
- `price_krw integer not null check (price_krw >= 0)`
- `billing_interval text not null check (billing_interval in ('monthly', 'yearly'))`
- `is_active boolean not null default true`
- `created_at timestamptz not null default now()`

### `plan_features`

- `plan_id uuid not null references plans(id) on delete cascade`
- `feature_code text not null references features(code) on delete cascade`
- primary key `(plan_id, feature_code)`

두 외래 키 컬럼에 인덱스를 둔다. 상위 요금제의 기능을 애플리케이션에서 직접 복제하지 않고, 조회 시 해당 플랜의 기능 목록을 계산한다.

### `subscriptions`

- `id uuid primary key default gen_random_uuid()`
- `organization_id uuid not null references organizations(id) on delete cascade`
- `plan_id uuid not null references plans(id)`
- `status text not null check (status in ('trialing', 'active', 'past_due', 'canceled', 'expired'))`
- `starts_at timestamptz not null`
- `ends_at timestamptz`
- `created_at timestamptz not null default now()`
- `updated_at timestamptz not null default now()`

활성 구독은 `status in ('trialing', 'active')`이고 `ends_at`이 없거나 현재 시각 이후인 행으로 정의한다. 조직별 동시 활성 구독은 서비스 계층에서 하나만 허용하고, 데이터베이스에는 상태·기간 조회용 인덱스를 둔다.

## API 계약

### 인증

- `POST /api/v1/auth/signup`
  - 입력: 이메일, 비밀번호, 표시 이름
  - 출력: 세션 또는 이메일 확인 필요 상태
- `POST /api/v1/auth/login`
  - 입력: 이메일, 비밀번호
  - 출력: access token, refresh token, 사용자 요약
- `POST /api/v1/auth/refresh`
  - 입력: refresh token
  - 출력: 새 세션
- `GET /api/v1/me`
  - Bearer token 필요
  - 출력: 사용자와 현재 조직 요약

### 조직

- `POST /api/v1/organizations`
  - 로그인 사용자에게 조직과 owner 멤버십 생성
- `GET /api/v1/organizations`
  - 사용자가 속한 조직 목록
- `GET /api/v1/organizations/{organization_id}/members`
  - owner/admin만 호출 가능

### 권한

- `GET /api/v1/organizations/{organization_id}/entitlements`
  - 활성 구독과 허용된 기능 코드 목록 반환
- `GET /api/v1/organizations/{organization_id}/subscriptions/current`
  - 현재 구독 요약 반환
- 보호된 업무 API는 `required_feature` 검사 의존성을 사용한다.

권한 오류는 일관되게 반환한다.

- 인증 없음/잘못된 토큰: `401`
- 조직 멤버가 아님: `403`
- 기능 코드가 구독에 없음: `403` 및 `feature_code`
- 존재하지 않는 조직·리소스: `404`

## 데스크톱 흐름

1. 앱이 로그인 화면을 표시한다.
2. 로그인 성공 후 access token을 메모리 세션에 보관한다.
3. 앱이 사용자의 조직과 entitlement 목록을 조회한다.
4. 메뉴 카탈로그의 `required_feature`와 entitlement를 비교한다.
5. 허용되지 않은 메뉴는 비활성화하고 업그레이드 안내를 표시한다.
6. 실제 작업 요청은 항상 access token과 함께 FastAPI로 보낸다.

refresh token은 운영 정책을 정한 뒤 안전한 OS 자격 증명 저장소에 저장한다. 서비스 키와 데이터베이스 비밀번호는 데스크톱 앱에 포함하지 않는다.

## 보안 원칙

- `public` 스키마의 모든 애플리케이션 테이블에 RLS를 활성화한다.
- RLS 정책의 역할 판정에는 `TO authenticated`와 소유·멤버십 조건을 함께 사용한다.
- `auth.role()`을 사용하지 않고 `(select auth.uid())`를 사용한다.
- 역할과 구독 상태를 `user_metadata`에 저장하지 않는다.
- 서비스 키를 사용하는 서버 코드도 조직 권한 검사를 생략하지 않는다.
- 새 테이블 자동 노출을 사용하지 않고, 필요한 테이블만 Data API에 노출한다.
- API 응답에서 다른 조직의 데이터가 존재하는지 추측할 수 있는 오류를 최소화한다.

## 테스트 전략

- 단위 테스트: 토큰 검증 결과, 멤버십 역할, 활성 구독 계산, 기능 권한 판정
- API 테스트: `401`, `403`, `404`, 정상 entitlement 응답
- 데이터베이스 테스트: 조직 간 데이터 격리, 멤버십 중복 방지, RLS 정책
- 데스크톱 테스트: entitlement별 메뉴 활성화·비활성화
- 외부 Supabase 호출은 포트 인터페이스 뒤에 두고, 기본 테스트는 결정적인 가짜 어댑터로 수행한다.

## 단계별 산출물

1. 인증 포트와 FastAPI 의존성
2. 초기 스키마·RLS 마이그레이션 및 시드 데이터
3. 조직·멤버십 API
4. 구독·entitlement 서비스와 API
5. 데스크톱 로그인·entitlement 연동
6. 전체 품질 검사와 운영 문서
