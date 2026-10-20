# 설치본 서명과 자동 업데이트 (릴리스 운영)

이 문서는 Windows 설치 파일(NSIS)을 만들고, 업데이트 서명 키로 서명하고, 앱이 새 버전을 받도록 업데이트 서버를 준비하는 방법을 설명합니다. 앱 코드는 이미 준비되어 있으며, **서명 키와 업데이트 서버 주소만 채우면** 동작합니다. 둘 중 하나라도 비어 있으면 앱은 정상 시작하고 설정 화면에 "업데이트 서버가 설정되지 않았습니다(관리자 설정 필요)"만 표시합니다.

!!! warning "비밀키는 저장소에 절대 커밋하지 않습니다"
    업데이트 서명 비밀키(`*.key`)가 유출되면 누구나 가짜 업데이트를 만들어 모든 사용자 PC에 설치시킬 수 있습니다. 저장소·메신저·이슈·로그에 올리지 말고, 아래 "비밀키 보관"대로 GitHub 시크릿과 오프라인 백업에만 둡니다.

## 한눈에 보기

| 구분 | 무엇 | 어디에 |
| --- | --- | --- |
| 업데이트 서명 키 쌍 | 앱이 내려받은 설치 파일의 진위를 검증 (minisign) | 공개키: `tauri.conf.json`/변수, 비밀키: 시크릿 |
| 업데이트 서버 주소 | `latest.json` 을 돌려주는 HTTPS 주소 | 변수 또는 환경변수 |
| 코드 서명 인증서 (선택) | Windows SmartScreen·"알 수 없는 게시자" 경고 완화 | 시크릿 |
| 릴리스 워크플로 | 태그를 올리면 빌드·서명·초안 릴리스 | `.github/workflows/release.yml` |

두 서명은 별개입니다. **업데이트 서명**은 앱이 자체 검증하는 것이고, **코드 서명**은 Windows가 설치 파일 게시자를 표시하는 것입니다.

## 1. 업데이트 서명 키 만들기 (최초 1회)

```powershell
cd apps\desktop-react
pnpm tauri signer generate -w $HOME\.tauri\business-assistant.key
```

- 암호를 묻습니다. 암호를 정하고 안전한 곳(비밀번호 관리자)에 기록합니다.
- 두 파일이 생깁니다. `business-assistant.key`(**비밀키**)와 `business-assistant.key.pub`(**공개키**).
- 비밀키 파일은 저장소 밖(위 예시는 사용자 홈)에 만듭니다. 저장소 안에 만들었다면 커밋하지 말고 즉시 옮기세요.

### 비밀키 보관

1. GitHub 저장소 Settings > Secrets and variables > Actions 에 시크릿 두 개를 등록합니다.
    - `TAURI_SIGNING_PRIVATE_KEY`: `.key` 파일의 **내용 전체**
    - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: 위에서 정한 암호
2. `.key` 파일과 암호를 오프라인(암호화된 USB, 비밀번호 관리자 등)에 백업합니다. **키를 잃으면 이미 설치된 앱은 새 키로 서명한 업데이트를 받을 수 없습니다**(앱을 새로 설치해야 합니다).
3. 키 교체가 필요하면 새 공개키를 넣은 버전을 먼저 기존 키로 서명해 배포한 뒤 교체합니다.

### 공개키 넣는 곳

공개키(`.pub` 파일의 내용 한 줄)는 비밀이 아닙니다. 두 곳에 넣습니다.

- **릴리스 빌드**: GitHub 저장소 변수 `TAURI_UPDATER_PUBKEY` (워크플로가 빌드 설정에 주입합니다).
- **직접 빌드할 때(선택)**: `apps/desktop-react/src-tauri/tauri.conf.json` 의 `plugins.updater.pubkey`. 현재 값 `REPLACE_WITH_UPDATER_PUBLIC_KEY` 는 자리표시자이며, 이 값이 그대로면 앱은 업데이트 기능을 끈 상태로 시작합니다(오류·크래시 없음).

## 2. 업데이트 서버 정하기

앱은 엔드포인트 주소로 `latest.json` 을 받아 현재 버전보다 높으면 새 버전으로 봅니다. 주소는 **HTTPS만** 허용됩니다(로컬 `http://127.0.0.1` 은 개발(debug) 빌드에서만).

### 선택지 A: GitHub Releases의 latest.json 직접 사용 (권장 시작점)

릴리스 워크플로가 `latest.json` 과 설치 파일을 릴리스에 올립니다. 발행(draft 해제)된 최신 릴리스의 파일은 다음 고정 주소로 받을 수 있습니다.

```text
https://github.com/<소유자>/<저장소>/releases/latest/download/latest.json
```

- 변수 `BUSINESS_ASSISTANT_UPDATE_ENDPOINT` 를 비워 두면 워크플로가 위 주소(현재 저장소)를 앱에 심습니다.
- **비공개 저장소는 이 주소를 인증 없이 받을 수 없으므로 앱 업데이트에 쓸 수 없습니다.** 비공개 저장소라면 선택지 B를 쓰세요.
- 초안(draft)·사전 릴리스(prerelease)는 `latest` 로 취급되지 않습니다. 발행해야 사용자에게 전달됩니다.

### 선택지 B: 자체 서버

HTTPS로 `latest.json` 과 설치 파일을 제공하는 아무 정적 서버(Nginx, 객체 저장소 + CDN 등)면 됩니다. 서버 로직이 필요 없습니다. 발행 시 `latest.json` 과 `*-setup.exe` 를 올리고, `latest.json` 의 `url` 을 그 서버의 설치 파일 주소로 고치면 됩니다.

### latest.json 형식

```json
{
  "version": "0.2.0",
  "notes": "고객 목록 개선",
  "pub_date": "2026-10-20T01:00:00.000Z",
  "platforms": {
    "windows-x86_64": {
      "signature": "<설치 파일.sig 파일의 내용>",
      "url": "https://github.com/<소유자>/<저장소>/releases/download/v0.2.0/Business-Assistant_0.2.0_x64-setup.exe"
    }
  }
}
```

- `version` 은 SemVer이며 앱의 현재 버전보다 높아야 업데이트로 인식됩니다.
- `signature` 는 `.sig` 파일 **내용**입니다(파일 경로가 아닙니다).
- 워크플로는 이 파일을 `scripts/release/make-latest-json.mjs` 로 자동 생성합니다. GitHub는 업로드한 파일 이름의 공백을 점으로 바꾸므로 스크립트가 공백을 `-` 로 바꾼 이름으로 올립니다.

### 엔드포인트 설정 방법 (우선순위)

| 순서 | 방법 | 용도 |
| --- | --- | --- |
| 1 | 실행 환경변수 `BUSINESS_ASSISTANT_UPDATE_ENDPOINT` | 사용자 PC 단위 재지정, 테스트 |
| 2 | 빌드 시 환경변수 `BUSINESS_ASSISTANT_UPDATE_ENDPOINT` | 앱에 값 내장 |
| 3 | `tauri.conf.json` 의 `plugins.updater.endpoints[0]` | 릴리스 빌드에서는 워크플로가 채움 |

모두 비어 있으면 미설정으로 취급합니다. 주소에는 `{{target}}`, `{{arch}}`, `{{current_version}}` 템플릿을 쓸 수 있습니다.

## 3. Windows 코드 서명 (선택, 권장)

코드 서명이 없어도 설치와 자동 업데이트는 동작하지만, 설치 파일 실행 시 Windows SmartScreen이 "PC를 보호했습니다 > 추가 정보 > 실행" 경고를 띄웁니다.

### 인증서 조달

| 종류 | 특징 |
| --- | --- |
| OV(조직 인증) 코드 서명 | 비교적 저렴. SmartScreen 평판이 쌓일 때까지(다운로드 수·시간) 경고가 남을 수 있음 |
| EV(확장 인증) 코드 서명 | 사업자 심사 강화, 보통 하드웨어 토큰/클라우드 HSM. 즉시 SmartScreen 신뢰에 유리 |

사업자 확인이 필요하므로 인증 기관(CA)에서 구매하세요. 최근 CA는 개인키를 하드웨어 토큰·클라우드 HSM에 두도록 요구하는 경우가 많아, `.pfx` 파일을 주지 않으면 아래 시크릿 방식을 그대로 쓸 수 없습니다. 그런 경우에는 Tauri 사용자 지정 서명 명령을 사용할 수 있습니다.

### 하드웨어 토큰·클라우드 서명 도구 사용

릴리스 설정 생성기는 선택 변수 `WINDOWS_SIGN_COMMAND` 를 `bundle.windows.signCommand` 에 전달한다. 명령에는 서명할 파일을 대신할 `%1` 을 정확히 한 번 넣어야 한다. 예를 들어 Tauri가 안내하는 `relic` 구성은 `relic sign --file %1 --key azure --config relic.conf` 형태다. 도구와 인증 수단은 릴리스 runner에 미리 준비한다.

- GitHub Actions **Variables** 에 `WINDOWS_SIGN_COMMAND` 를 넣는다. 암호·토큰·개인키는 명령 문자열에 넣지 않는다. 명령이 OS 사용자 인증이나 runner의 인증된 클라우드 도구를 사용하게 한다.
- 기본 GitHub 호스팅 runner에는 사용자의 USB 토큰이 연결되어 있지 않다. 하드웨어 토큰은 Windows self-hosted runner에 드라이버·서명 도구·토큰을 준비하고, 변수 `WINDOWS_SIGN_RUNNER` 에 전용 runner 레이블을 지정한다. self-hosted runner는 보호된 릴리스 태그만 실행하도록 제한한다. Azure 같은 클라우드 서명 도구는 해당 도구가 설치되고 인증 가능한 runner를 사용한다.
- 사용자 지정 명령은 SHA-256 코드 서명과 타임스탬프를 직접 처리해야 한다. `WINDOWS_TIMESTAMP_URL` 및 PFX 변수는 사용자 지정 명령과 함께 사용할 수 없다. `.pfx` 시크릿과 `WINDOWS_SIGN_COMMAND` 를 같이 설정하면 릴리스 설정 생성이 실패한다.
- 서명 명령은 빌드된 바이너리마다 실행된다. runner에서 해당 명령을 직접 시험하고 나서 릴리스 태그를 실행한다. 자격 증명과 실제 토큰 연결 확인은 이 저장소에서 하지 않았다.

Tauri의 `%1` 치환과 사용자 지정 서명 명령은 [공식 Windows 코드 서명 안내](https://v2.tauri.app/distribute/sign/windows/)를 참고한다.

### 적용 (`.pfx` 인증서를 받은 경우)

저장소 시크릿 두 개를 등록하면 워크플로가 자동으로 서명합니다. 없으면 서명 없이 빌드하고 경고만 남깁니다.

| 시크릿 | 값 |
| --- | --- |
| `WINDOWS_CERTIFICATE` | `.pfx` 파일을 base64로 인코딩한 문자열 (`[Convert]::ToBase64String([IO.File]::ReadAllBytes("인증서.pfx"))`) |
| `WINDOWS_CERTIFICATE_PASSWORD` | `.pfx` 암호 |

선택 변수 `WINDOWS_TIMESTAMP_URL` 로 타임스탬프 서버를 바꿀 수 있습니다(기본 `http://timestamp.digicert.com`). 워크플로는 인증서를 임시 파일로 풀어 현재 사용자 인증서 저장소에 가져온 뒤 파일을 지우고, 지문(`certificateThumbprint`)만 빌드 설정에 넣습니다. 저장소의 `tauri.conf.json` 에는 지문·경로가 들어 있지 않습니다(값 비움).

## 4. 설정 변수 정리

| 이름 | 종류 | 필수 | 설명 |
| --- | --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | 시크릿 | 예 | 업데이트 서명 비밀키 내용 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 시크릿 | 암호가 있으면 | 비밀키 암호 |
| `TAURI_UPDATER_PUBKEY` | 변수 | 예 | 업데이트 공개키(.pub 내용) |
| `BUSINESS_ASSISTANT_API_BASE` | 변수 | **예** | 설치된 앱이 접속할 HTTPS API 주소(예: `https://api.example.com/api/v1`). 설치 파일에 박혀 들어간다. 없으면 릴리스 빌드가 멈춘다 |
| `BUSINESS_ASSISTANT_ADMIN_API_BASE` | 변수 | 아니오 | 관리자 API 주소. 비우면 앱의 구독 메뉴가 숨겨진다 |
| `BUSINESS_ASSISTANT_STORAGE_HOST` | 변수 | 아니오 | 사진·파일 서명 URL을 허용할 Storage 호스트. 비우면 `*.supabase.co`만 허용 |
| `BUSINESS_ASSISTANT_UPDATE_ENDPOINT` | 변수/환경변수 | 아니오 | 업데이트 주소(https). 비우면 이 저장소의 Releases `latest.json` |
| `BUSINESS_ASSISTANT_UPDATE_AUTOCHECK` | 실행 환경변수 | 아니오 | `0` 이면 시작 30초 뒤 자동 확인을 끔 |
| `WINDOWS_CERTIFICATE` | 시크릿 | 아니오 | 코드 서명 `.pfx`(base64) |
| `WINDOWS_CERTIFICATE_PASSWORD` | 시크릿 | 인증서가 있으면 | `.pfx` 암호 |
| `WINDOWS_TIMESTAMP_URL` | 변수 | 아니오 | 코드 서명 타임스탬프 서버 |
| `WINDOWS_SIGN_COMMAND` | 변수 | 아니오 | HSM/클라우드 사용자 지정 서명 명령(`%1` 한 번 포함, 인증정보 금지). PFX 지문 방식과 함께 쓸 수 없음 |
| `WINDOWS_SIGN_RUNNER` | 변수 | 아니오 | 사용자 지정 서명 도구를 갖춘 runner 레이블. 기본 `windows-latest` |

## 5. 릴리스 절차 체크리스트

1. **버전 올리기**: 아래 세 곳을 같은 값으로 맞춥니다(예: `0.2.0`). 다르면 워크플로가 실패합니다.
    - `apps/desktop-react/src-tauri/tauri.conf.json` 의 `version`
    - `apps/desktop-react/src-tauri/Cargo.toml` 의 `[package] version` (그리고 `cargo check` 로 `Cargo.lock` 갱신)
    - `apps/desktop-react/package.json` 의 `version`
2. 변경 이력(`docs/product/changelog.md`)을 갱신하고 `main` 에 병합합니다.
3. **태그 올리기**: 앱 버전 앞에 `v` 를 붙입니다. `git tag v0.2.0 && git push origin v0.2.0` (또는 Actions > "릴리스" > Run workflow 에 태그 입력).
4. Actions 의 "릴리스" 실행이 성공하는지 확인합니다. 시크릿이 없으면 "서명 설정 확인" 단계에서 멈추고 이유를 알려 줍니다.
5. **초안 릴리스 확인**: Releases 에 올라온 초안에서 `Business-Assistant_<버전>_x64-setup.exe`, `.sig`, `latest.json` 세 파일이 있는지, `latest.json` 의 `version`·`url` 이 맞는지 확인합니다.
6. (권장) 초안의 설치 파일을 **깨끗한 PC에서 설치**하고, 이전 버전 앱에서 설정 > 업데이트 확인으로 업그레이드를 시험합니다. 이 시험은 발행 전에는 업데이트 서버(`latest`)에 노출되지 않으므로, 임시 서버나 `BUSINESS_ASSISTANT_UPDATE_ENDPOINT` 를 가리킨 테스트 `latest.json` 으로 수행합니다.
7. 릴리스 노트를 정리하고 **발행(Publish release)** 합니다. 발행하는 순간부터 사용자 앱이 `latest.json` 을 통해 새 버전을 받습니다.

## 6. 롤백 방법

앱은 현재보다 **낮은 버전으로는 업데이트하지 않습니다.** 그래서 롤백은 "이전 내용을 새 버전 번호로 다시 배포"하는 방식입니다.

1. 문제가 된 릴리스를 즉시 **초안으로 되돌리거나 삭제**합니다(`latest` 가 직전 발행 릴리스로 돌아가 추가 확산이 멈춥니다). 자체 서버라면 `latest.json` 을 직전 버전 파일로 되돌립니다.
2. 이미 새 버전을 설치한 PC에는 그 버전이 남아 있으므로, 문제 없는 코드로 되돌린 수정판을 **더 높은 버전**(예: 0.2.1)으로 같은 절차로 배포합니다.
3. 치명적이면 사용자에게 직전 설치 파일로 수동 재설치(덮어 설치)를 안내합니다.

## 7. 보안 주의

- 비밀키·암호·`.pfx`는 저장소, 이슈, 채팅, 로그에 남기지 않습니다. 워크플로는 시크릿을 필요한 단계에만 넘기며 출력하지 않습니다.
- 서명 시크릿을 등록한 저장소는 관리자만 쓰기 권한을 갖도록 하고, `v*` 태그 보호 규칙(Settings > Rules)으로 아무나 태그를 올리지 못하게 합니다.
- 비밀키 유출이 의심되면 즉시 새 키 쌍을 만들고 기존 시크릿을 폐기합니다. 이미 설치된 앱은 새 키를 모르므로 새 설치 파일을 직접 배포해야 합니다.
- 업데이트 주소는 HTTPS여야 하며, 서명 검증이 실패한 파일은 설치되지 않습니다.
- 워크플로의 쓰기 권한(`contents: write`)은 초안 릴리스를 올리는 잡에만 있습니다. 서드파티 액션은 쓰지 않고 GitHub 공식 액션(`checkout`, `setup-node`, `cache`, `upload-artifact`, `download-artifact`)과 `gh` CLI만 사용합니다. 더 엄격하게 하려면 액션 버전을 커밋 SHA로 고정하세요.

## 8. 로컬에서 릴리스 빌드 시험

서명 키가 있을 때 로컬에서도 같은 방식으로 만들 수 있습니다(비밀키는 환경변수로만 전달).

```powershell
$env:TAURI_UPDATER_PUBKEY = Get-Content $HOME\.tauri\business-assistant.key.pub -Raw
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content $HOME\.tauri\business-assistant.key -Raw
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "<암호>"
$env:BUSINESS_ASSISTANT_UPDATE_ENDPOINT = "https://example.com/latest.json"
node scripts/release/make-release-config.mjs
cd apps\desktop-react
pnpm tauri build --config src-tauri/target/release-config/tauri.release.conf.json
```

일반 `pnpm tauri build` 는 업데이트 산출물을 만들지 않으므로 서명 키 없이도 동작합니다. 업데이트 산출물(`.sig`)은 위 릴리스 설정으로 빌드할 때만 생깁니다.
