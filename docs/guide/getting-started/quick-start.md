# 빠른 시작

## 준비물

- Windows PC
- Git
- Node.js 24 이상
- Native 데스크톱 앱 실행용 Rust MSVC 도구 체인(`cargo`)
- 활성 상태의 Supabase 프로젝트
- 저장소의 `.env`에 입력할 Supabase URL과 키

!!! warning "비밀값 보관"
    `.env`는 로컬 PC에만 둡니다. `APP_SUPABASE_SERVICE_KEY`와 데이터베이스 연결 문자열을 화면 캡처, 문서, 데스크톱 앱이나 Git에 넣지 마세요.

## 1. 프로젝트 준비

PowerShell에서 저장소 루트로 이동한 뒤 한 번만 실행합니다.

```powershell
Set-Location -LiteralPath "C:\path\to\business-assistant"
powershell -ExecutionPolicy Bypass -File .\scripts\bootstrap.ps1
Copy-Item .env.example .env
```

`.env`를 열어 최소한 다음 항목을 입력합니다.

```dotenv
APP_FILE_BUCKET=business-files
APP_SUPABASE_URL=https://프로젝트-ID.supabase.co
APP_SUPABASE_PUBLISHABLE_KEY=발급받은-publishable-key
```

서비스 키는 일반 앱 실행에 입력하지 않습니다. 별도 관리자 API를 운영할 때만 관리자 서버 환경에 설정합니다.

Supabase SQL을 처음 적용한다면 [SQL 적용 안내](../admin/supabase.md)를 먼저 완료하세요.

## 2. 앱 실행

저장소 루트에서 아래 명령 하나로 API와 Native 데스크톱 앱을 실행합니다.

```powershell
Set-Location -LiteralPath "C:\path\to\business-assistant"
.\run-app.cmd
```

`Business Assistant` Native Tauri 창이 열립니다. 로그인 후 조직을 선택하면 홈 대시보드가 열립니다. 앱 창을 닫으면 이 명령으로 함께 시작한 API도 종료됩니다.

UI만 빠르게 확인할 때는 아래 브라우저 미리보기를 사용할 수 있습니다. 이 명령은 제품 앱 실행 명령이 아닙니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run-react-web.ps1
```

## 3. 종료

1. 작성 중인 고객·시술·문서를 저장하거나 취소합니다.
2. 데스크톱 창을 닫습니다.
3. 앱을 시작한 PowerShell 창으로 돌아가 실행이 끝났는지 확인합니다.

앱이 이미 실행 중이라면 같은 프로그램을 다시 띄우기 위해 무조건 종료할 필요는 없습니다. 소스 또는 `.env`를 바꿨을 때만 서버와 앱을 재시작합니다.

## 다음 단계

- [화면 구성과 기본 조작](interface.md)
- [고객 등록부터 결제까지](../workflows/customer-to-payment.md)
- [실행 문제가 생겼을 때](../troubleshooting.md)
