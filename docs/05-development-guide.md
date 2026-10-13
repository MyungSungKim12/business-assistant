# 개발 환경 안내

## 준비물

- Windows PowerShell
- Git
- 인터넷 연결(처음 의존성을 내려받을 때 필요)
- Node.js 24 이상과 Corepack
- Native 앱 빌드용 Rust MSVC 도구 체인

현재 제품 서버와 데스크톱은 Node.js·React·Tauri를 사용합니다. Python/uv는 이전 마이그레이션과 일부 문서 도구를 확인할 때만 필요합니다.

## 처음 한 번 실행

저장소 루트에서 다음을 실행합니다.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/bootstrap.ps1
```

스크립트는 현재 PowerShell에서 `uv`를 먼저 찾고, 없다면 일반 설치 경로인 `C:\Users\<사용자>\.local\bin\uv.exe`를 찾습니다. 둘 다 없으면 설치 방법이 포함된 오류를 보여 줍니다. 설치는 [uv 안내](https://docs.astral.sh/uv/getting-started/installation/)를 따른 뒤 새 PowerShell을 열어 다시 실행하세요.

## 검사와 테스트

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check.ps1
```

이 명령은 Ruff 린트, Ruff 포맷 검사, mypy 타입 검사, pytest를 순서대로 실행합니다. 한 명령이라도 실패하면 즉시 멈춥니다. 개별 테스트는 `uv run pytest`, 포맷 자동 적용은 `uv run ruff format .`로 실행할 수 있습니다.

## 서버와 React/Tauri 데스크톱 시작

각 명령은 별도 PowerShell 창에서 실행하세요.

```powershell
powershell -ExecutionPolicy Bypass -File scripts/run-server.ps1
powershell -ExecutionPolicy Bypass -File scripts/run-react-desktop.ps1
```

서버는 기본적으로 `http://127.0.0.1:8000`에서 시작하며 상태 확인 주소는 `http://127.0.0.1:8000/api/v1/health`입니다. 두 번째 명령은 Native Tauri 창을 엽니다. `scripts/run-react-web.ps1`은 UI 개발용 브라우저 미리보기입니다.

## 환경 변수

`.env.example`을 복사해 `.env`를 만들고 필요한 값만 채웁니다.

```powershell
Copy-Item .env.example .env
```

`APP_ENVIRONMENT`와 `APP_API_BASE_URL`은 로컬 예시 값입니다.
데스크톱은 시작할 때 `.env`를 명시적으로 읽되 현재 셸에 설정된 값을 덮어쓰지 않으며,
`APP_API_BASE_URL`만 Node/Fastify API 연결 주소로 사용합니다. 이전 `BUSINESS_ASSISTANT_API_URL`은
호환성용 대체값일 뿐 `APP_API_BASE_URL`이 항상 우선합니다. 데스크톱은 `.env`의 Supabase·서비스 키·데이터베이스 값을 읽거나 출력하지 않습니다.
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

### `uv`를 찾을 수 없다는 오류

`C:\Users\<사용자>\.local\bin\uv.exe`가 있는지 확인합니다. 없다면 uv를 설치하고 새 PowerShell을 엽니다. 스크립트는 전역 PATH를 변경하지 않고 실행 중인 프로세스에서만 이 경로를 사용합니다.

### Native Tauri 창을 시작할 수 없음

`cargo --version`으로 Rust/Cargo 설치를 확인하고, Windows MSVC C++ 빌드 도구가 설치되어 있는지 확인한 뒤 `scripts/run-react-desktop.ps1`을 다시 실행합니다. `scripts/run-react-web.ps1`은 기능 확인용 브라우저 미리보기이며 제품 앱 배포 결과가 아닙니다.
