# Supabase 인증 권한 설정

이 안내는 로컬 개발 환경에서 Supabase Auth와 조직별 구독 권한 스키마를 연결하는 순서입니다.
실제 프로젝트 URL, 키, 데이터베이스 비밀번호, 액세스 토큰은 문서·소스·커밋·로그에 넣지
않습니다.

## 1 프로젝트 만들기

1. Supabase Dashboard에서 개발용 새 프로젝트를 만듭니다. 운영 프로젝트와 개발 프로젝트는
   분리합니다.
2. 프로젝트가 준비되면 Dashboard의 Connect 또는 API 설정에서 프로젝트 URL과
   publishable key를 확인합니다.
3. 서버에서 관리자 작업이 필요한 경우에만 service key를 확인합니다. service key는 서버
   전용 비밀값이며 데스크톱 앱이나 브라우저 클라이언트에 전달하지 않습니다.

이 저장소의 현재 Auth 어댑터는 `APP_SUPABASE_URL`과
`APP_SUPABASE_PUBLISHABLE_KEY`로 로그인, 회원가입, 토큰 검증을 수행합니다.
`APP_SUPABASE_SERVICE_KEY`는 서버 전용으로 보관할 수 있지만, 클라이언트 설정이나
`APP_SUPABASE_PUBLISHABLE_KEY`의 대체값으로 사용하면 안 됩니다.

## 2 로컬 환경 변수 입력

저장소 루트에서 예시 파일을 복사합니다.

```powershell
Copy-Item .env.example .env
```

`.env`에 다음 항목을 입력합니다. 오른쪽 값은 예시가 아니라 각자의 Supabase 프로젝트에서
확인한 값이어야 합니다.

```dotenv
APP_SUPABASE_URL=
APP_SUPABASE_PUBLISHABLE_KEY=
APP_SUPABASE_SERVICE_KEY=
```

`.env`는 로컬 개발용 파일이며 `.gitignore`로 제외됩니다. `.env 파일을 Git에 추가하지
마세요.` `scripts/check.ps1`은 실수로 추적된 `.env`를 검사에서 실패로 처리합니다.
서비스 키와 데이터베이스 URL은 서버의 안전한 비밀 관리 방식으로만 배포하고, 데스크톱 앱,
클라이언트 설정, 설치 파일, 오류 메시지와 로그에 포함하지 않습니다.

## 3 마이그레이션 적용

Supabase Dashboard의 SQL Editor 또는 팀에서 사용하는 Supabase CLI 마이그레이션 절차로
다음 SQL 파일을 순서대로 적용합니다.

1. `migrations/001_auth_entitlements.sql`
2. `migrations/002_seed_entitlements.sql`

적용 대상이 개발 프로젝트인지 먼저 확인합니다. SQL은 `profiles`, `organizations`,
`memberships`, 상품·기능·구독 테이블과 기본 BASIC, STANDARD, PRO 권한 데이터를
만듭니다. 상세 내용은 [마이그레이션 안내](../migrations/README.md)를 확인하세요.

모든 `public` 애플리케이션 테이블에는 RLS를 활성화합니다. RLS는 publishable key를
사용하는 클라이언트의 조직 간 데이터 접근을 제한하는 최후의 경계입니다. RLS를 끄거나
service key로 클라이언트 정책을 우회하지 마세요. FastAPI 서버도 Bearer 토큰, 조직
멤버십, 구독 entitlement를 매 요청마다 별도로 검증해야 합니다.

## 4 테스트와 실행

의존성을 처음 준비할 때는 다음을 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
```

설정과 문서 계약만 빠르게 확인하려면 다음을 실행합니다.

```powershell
uv run pytest apps/server/tests/test_config.py -q
```

전체 린트, 포맷, 타입 검사와 테스트는 다음 명령으로 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check.ps1
```

서버와 데스크톱 앱을 별도 PowerShell 창에서 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-server.ps1
powershell -ExecutionPolicy Bypass -File scripts/run-desktop.ps1
```

`APP_SUPABASE_URL` 또는 `APP_SUPABASE_PUBLISHABLE_KEY`가 비어 있으면 인증 API는
설정 오류를 반환합니다. 기본 테스트는 외부 Supabase 자격 증명 없이도 실행할 수 있습니다.

## 5 이메일 확인 회원가입 흐름

호스팅된 Supabase 프로젝트는 일반적으로 **Confirm email**을 기본으로 켭니다. 이 설정에서
`POST /api/v1/auth/signup`이 성공하면 서버는 access token이나 refresh token 없이 다음 응답을
반환합니다.

```json
{"email_confirmation_required": true}
```

데스크톱 앱은 사용자가 가입할 때 쓴 메일함에서 Supabase 확인 링크를 열도록 안내해야 합니다.
확인 전에는 로그인 세션이 발급되지 않으므로 보호된 API를 호출하지 않습니다. 확인을 마친 뒤
일반 로그인 API를 호출하면 세션 응답을 받습니다. Confirm email을 끈 개발 환경에서는 회원가입
응답에 `email_confirmation_required: false`와 세션 토큰, 사용자 요약이 함께 옵니다.

Supabase Dashboard의 Auth Providers에서 Confirm email 설정과 `SITE_URL` 및 허용된 redirect URL을
개발·운영 환경별로 확인하세요. 확인 메일 발송에는 SMTP 구성이 필요하며, 운영 환경에는 신뢰할 수
있는 SMTP 공급자를 사용합니다. 확인 링크·토큰·서비스 키를 로그나 오류 화면에 표시하지 마세요.
