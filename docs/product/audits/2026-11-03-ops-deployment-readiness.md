# N1030-12 운영 배포·복구 준비 점검 — 2026-11-03

## 범위와 상태

N1030-12를 **문서/소스 설정 점검 범위에서 verified (bounded)** 로 기록한다. 이 작업은 실제 서버·도메인·설치본을 만들거나 공개하지 않고, 이미 구현된 배포 계약과 기기/세션 동작을 새 사용자가 따라갈 수 있게 정리하며 DB와 Storage 복구 절차를 마련한다.

기준 파일: `apps/desktop-react/src-tauri/src/config.rs`, `http.rs`, `update.rs`, `logfile.rs`, `tauri.conf.json`, `.github/workflows/release.yml`, Android `MainActivity.kt`/`SecurePhoneStore.kt`, `docs/guide/admin/deployment.md`, `docs/guide/admin/release.md`.

## 확인한 계약

### 서버 주소와 origin

- 설치된 Tauri 앱은 `BUSINESS_ASSISTANT_API_BASE` 실행 환경변수 → 빌드 시 내장된 `BUSINESS_ASSISTANT_API_BASE_DEFAULT` → 개발 빌드 로컬 주소 순으로 선택한다. release 빌드에 값이 없으면 앱 설정 오류로 거부한다.
- API 주소는 release에서 HTTPS만 허용하고 query/fragment는 거부한다. 릴리스 workflow도 `BUSINESS_ASSISTANT_API_BASE`가 `https://`로 시작하지 않으면 빌드를 중단한다. 최종 앱 주소는 API `/api/v1` 기반이어야 한다.
- 일반 업무 API와 플랫폼 관리자 API는 별도 주소/프로세스다. 관리자 주소 설정은 권한을 부여하지 않고 API에서 다시 검사한다. 공개 서명 페이지는 `APP_PUBLIC_DOCUMENT_SIGNING_ORIGIN`이 HTTPS로 고정 설정되기 전 링크 발행이 막힌다.
- React 개발용 Vite 프록시 주소는 설치 앱 주소가 아니다. Tauri 업무 통신은 네이티브 HTTP를 쓰며 API 접근에서 브라우저 CORS가 사용자 권한 검사를 대신하지 않는다.
- 실제 고정 도메인, DNS, TLS 인증서, 리버스 프록시, API 서비스의 가용성은 아직 공급되지 않았다. 그러므로 릴리스용 API 주소나 서명 origin을 임의 주소로 채우지 않는다.

### 계정 및 Android 기기 데이터

- 설정의 계정 세션 목록은 실제 인증 세션을 개별/전체 철회한다. `user_agent`/시각은 보조 정보이므로 정확한 하드웨어 식별이나 원격 기기 잠금으로 간주하지 않는다.
- Android 번호부 동기화 철회는 이 기기의 암호화 번호부를 지우고 동기화 작업을 취소한다. 서버 로그인 세션 철회와는 별도 동작이다.
- 현재 물리 기기 고유 등록부, MDM 연동, 오프라인 기기의 원격 데이터 삭제는 구현되어 있지 않다. 이 범위는 문서와 사용자 조치 절차로 설명한다. 조직이 원격 삭제를 요구하면 별도 기기 등록·키 수명·철회 API 설계가 필요하다.

### 업데이트 서명과 진단

- Tauri updater는 HTTPS endpoint와 설정된 공개키로 업데이트 서명을 검증한다. 설정에 placeholder 공개키와 빈 endpoint가 있으므로 현재 저장소 설정만으로 자동 업데이트가 켜진 상태가 아니다. 실제 updater private key는 GitHub secret 등 별도 보호 저장소에 두고, 공개키·endpoint와 릴리스 runner를 인수해야 한다.
- Windows 코드 서명 인증서와 updater 서명키는 다른 용도다. 어느 것도 아직 실제 발급자/runner로 인수했다는 증거는 없다.
- 앱 오류 화면은 복사 가능한 제한 진단을 제공한다. Tauri 로컬 로그는 회전/전화번호 일부 가림을 적용하지만 고객 이름을 포함한 모든 내용을 익명화한다고 보장하지 않는다. 지원에 전달하기 전에 검토해야 한다.
- 이 점검에서 placeholder 키·주소를 채우거나 실제 updater 다운로드/설치를 수행하지 않았다.

## DB와 Storage 복구 운영안

`docs/guide/admin/deployment.md`에 두 단계 절차를 기록했다.

1. 운영과 분리된 프로젝트에서 DB 백업을 복원하고 별도 Storage 원본 사본의 bucket/object를 대조하는 정기 리허설.
2. 실제 장애 때 신규 쓰기와 비가역 후속 작업을 멈추고, 현재 상태를 보존한 뒤 승인된 DB 시점과 Storage object 사본을 각각 복구하고, 원장·RLS·파일 metadata/object 일치와 API health를 확인한 다음 쓰기를 재개.

DB 백업이 파일 바이너리를 포함한다고 가정하지 않는다. Storage 복구 기준, 실제 보존 범위·기간은 Supabase 프로젝트 플랜/설정에서 장애 전에 확인해야 한다. 이 저장소에서는 DB/Storage 복원, 운영 대사, 복구 리허설을 실행하지 않았다.

## 제한 및 미완료 외부 인수

- 고정 API 도메인/TLS/서버 배포 및 `.env` 설정.
- `APP_PUBLIC_DOCUMENT_SIGNING_ORIGIN` 운영 HTTPS 설정과 실제 모바일 서명 동선·고객 고지 문안 검토.
- updater 키 발급·비밀키 보관·공개키/HTTPS manifest 연결·서명된 설치/업데이트 검증.
- Windows 코드 서명/SmartScreen 정책과 깨끗한 PC 설치 인수.
- 실제 Android/S23 실기기 로그아웃/번호부 삭제/세션 철회 인수 및 분실 기기의 오프라인 잔존 데이터 정책.
- 격리 프로젝트 DB+Storage 복구 리허설. 실제 운영 복구를 이 점검의 완료 근거로 삼지 않는다.

## 검증 기록

- 배포 주소 결정·HTTPS 거부 및 누락 release 주소의 실패 경로는 Rust `config.rs`에 구현되어 있고, updater endpoint·공개키 누락 시 비활성화와 HTTPS 업데이트 검증은 `update.rs`에 있다.
- 계정 세션 철회 UI/API와 Android 로컬 번호부 동의 해제·저장자료 정리는 각각 기존 구현을 소스로 대조했다.
- 신규 서버·Supabase DB 변경은 없으며 SQL 실행도 없다.
- 실서버/설치본/모바일·복구 시험은 수행하지 않았다. 이 작업은 운영 인수 완료를 뜻하지 않는다.

## 다음 단계

서버·도메인·비밀키·코드 서명 인증서·복구용 Storage 사본을 준비할 때 이 문서의 외부 인수 항목을 차례로 처리한다. 업무 기능 코드상 다음 후속 작업은 사용자가 실제 설치 앱에서 N1030-01~11의 업무 흐름을 인수하고 실패/권한 결과를 기록하는 것이다.
