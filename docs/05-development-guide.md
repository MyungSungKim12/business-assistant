# 개발 환경 안내

## 준비물

- Windows PowerShell
- Git
- 인터넷 연결(처음 의존성을 내려받을 때 필요)
- Node.js 24 이상과 Corepack
- Native 앱 빌드용 Rust MSVC 도구 체인

현재 제품 서버와 데스크톱은 Node.js·React·Tauri를 사용합니다. Python은 MkDocs 문서 환경을 만들 때만 선택적으로 필요합니다.

## 처음 한 번 실행

저장소 루트에서 다음을 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
```

스크립트는 Corepack 또는 설치된 pnpm으로 의존성을 설치하고 앱 아이콘을 생성합니다. Native 앱 개발 창은 Rust MSVC 도구 체인과 Visual Studio C++ 빌드 도구가 필요합니다.

## 검사와 테스트

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check.ps1
```

이 명령은 TypeScript 타입 검사, API·React·공통 UI 테스트(vitest), Rust 테스트(cargo test), React 프로덕션 빌드를 순서대로 실행합니다. 한 명령이라도 실패하면 즉시 멈춥니다. 개별 테스트는 `corepack pnpm --filter @business-assistant/api test`처럼 패키지별로 실행할 수 있습니다.

## 서버와 데스크톱 앱 시작

저장소 루트에서 다음 명령으로 Node API와 Native Tauri 앱을 함께 실행합니다.

```powershell
.\run-app.cmd
```

`run-app.cmd`는 API가 준비된 뒤 Windows 앱 창을 엽니다. API만 실행하거나 브라우저 UI 미리보기를 실행하는 별도 스크립트도 있지만, 일반적인 로컬 앱 확인에는 이 명령을 사용하세요. API 기본 주소는 `http://127.0.0.1:8000`이며 상태 확인 주소는 `http://127.0.0.1:8000/api/v1/health`입니다.

## 환경 변수

`.env.example`을 복사해 `.env`를 만들고 필요한 값만 채웁니다.

```powershell
Copy-Item .env.example .env
```

`run-app.ps1`은 로컬 `.env`를 API 프로세스에만 전달하고, 서비스 키·DB URL·개발 자동 로그인 비밀값은 데스크톱 프로세스에서 제외합니다. API 기본 주소는 `http://127.0.0.1:8000`입니다. 설치 앱은 빌드에 설정한 HTTPS API 기본 주소를 사용합니다.
`APP_SUPABASE_URL`과 `APP_SUPABASE_PUBLISHABLE_KEY`는 Supabase Auth 클라이언트가
사용하는 설정입니다. publishable key는 공개 클라이언트 흐름에만 사용할 수 있고 서비스 키를
대신할 수 없습니다. `APP_SUPABASE_SERVICE_KEY`와 `APP_DATABASE_URL`은 서버 전용
비밀값으로, 데스크톱 앱, 배포 파일, 로그 또는 Git에 넣지 마세요. `.env`는 이미 Git에서
제외되며, `.env 파일을 Git에 추가하지 마세요.`

Supabase 프로젝트 생성, 키 확인, 마이그레이션 적용, 인증·권한 테스트 순서는
[Supabase 인증·권한 설정](08-supabase-setup.md)을 따릅니다. RLS는 클라이언트 접근의
조직 경계를 보조하므로, 서버 API도 모든 보호된 요청에서 토큰·조직 멤버십·기능 권한을
검사해야 합니다.

## 자주 만나는 문제

### Native Tauri 창을 시작할 수 없음

`cargo --version`으로 Rust/Cargo 설치를 확인하고, Windows MSVC C++ 빌드 도구가 설치되어 있는지 확인한 뒤 `run-app.cmd`를 다시 실행합니다. `scripts/run-react-web.ps1`은 기능 확인용 브라우저 미리보기이며 제품 앱 배포 결과가 아닙니다.
