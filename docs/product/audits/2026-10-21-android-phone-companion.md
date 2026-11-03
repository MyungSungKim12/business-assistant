# INT-006 Android 전화 연동 앱 구현 — 2026-10-21

## 후속 검증 — SDK 설치와 LTE/5G 시험 준비

- 사용자가 수동 고객 조회 성공 및 발신자가 S23 연락처에 저장되어 있음을 확인했다. Android 공식 CallScreeningService 계약상 READ_CONTACTS 미허용 시 저장된 연락처 전화는 서비스로 전달되지 않는다. 0.1.1에 설명 후 선택적으로 READ_CONTACTS를 요청하는 버튼, 전화 식별 역할/앱·채널 알림/선택 연락처 권한 상태 표시를 추가했다. 실제 연락처 목록을 조회하거나 전송하는 코드는 없다. 최근 이벤트의 시각/처리 상태만 Keystore 암호화로 기기에 기록해 USB 없이 원인 확인을 돕고, 로그아웃 시 삭제한다. OS 역할과 권한을 허용한 뒤 재통화 인수는 대기다.
- 0.1.1 검증: `build-android-companion.ps1 -ApiBaseUrl <현재 임시 HTTPS>/api/v1/ -UseTcpLoopback -Test` 빌드 성공, Kotlin 3 tests passed. aapt에서 versionCode=2/READ_CONTACTS 선언 확인, HTTPS 다운로드 APK와 로컬 산출물 SHA-256 일치 확인. 실제 S23 권한 요청/수신 알림은 사용자 인수 대기다.

- S23 설치·동기화 후 수동 조회가 빈 결과라는 사용자 보고를 받았다. 실제 저장소는 원본 국내 번호를 검색하는데 서버가 `82…`로 후보 검색하던 문제를 재현/수정했다. 현재 검색은 국가번호를 제외한 유효 번호 부분으로 후보 페이지를 모두 읽은 뒤 E.164 완전 일치만 반환한다. 국내·국가번호 혼합 저장, 중복 번호, 첫 200건 밖의 일치, 조직/활성 상태와 전화 메모 저장을 테스트한다. APK 재설치와 추가 SQL은 필요 없다. 사용자의 실제 재검색 결과는 대기다.
- 위 수정 후 `pnpm --filter @business-assistant/api exec vitest run src/modules/phone/phone.test.ts src/modules/phone/routes.test.ts` — 19 tests passed. API `tsc --noEmit` 통과. tsx watch의 서버 재시작 시각과 localhost/임시 HTTPS health 응답을 확인했다. 실제 계정으로 번호 조회/메모 저장은 사용자의 재확인 대기다.

- 사용자 SDK 설치 후 JDK 21/Gradle 8.10.2/Android SDK 35로 debug APK 빌드와 Kotlin 단위 테스트 3건을 통과했다. 첫 컴파일에서 발견한 `Call.Details.CALL_DIRECTION_INCOMING` 오참조를 실제 SDK 상수 `DIRECTION_INCOMING`으로 수정했다.
- 이 PC의 Java AF_UNIX connect가 `Invalid argument`로 실패하는 것을 재현했다. 빌드 스크립트에 `-UseTcpLoopback`을 추가해 OpenJDK PipeImpl의 TCP fallback을 빌드 프로세스에서만 사용하도록 했다. 시스템 보안/방화벽 설정은 변경하지 않았다. 빌드 후 기존 JAVA_TOOL_OPTIONS를 복원한다.
- `run-android-mobile-test.ps1`과 제한된 localhost 게이트웨이를 추가했다. 검증된 공식 cloudflared 바이너리로 임시 HTTPS 주소를 발급하고, 해당 URL을 담은 APK를 빌드한다. 임의 다운로드 토큰을 가진 링크로 S23 LTE/5G에서 APK를 받을 수 있다. 게이트웨이는 전화 연동에 필요한 API만 전달한다.
- `node --test scripts/android-test-gateway.test.mjs` — 1 test passed (경로 차단·Bearer 전달·다운로드 토큰·본문 한도). 공개 HTTPS에서 health=200, 미인증 조직 조회=401, `/.env`=404 확인. 클라우드 배포와 실제 고객 데이터 변경은 하지 않았다.
- 실기기 설치/전화/메모 인수는 대기다. 휴대폰 수신 이벤트를 PC 팝업으로 전달하는 기능은 미구현이다. INT-006 전체는 in-progress다.

아래는 SDK 설치 전 작성한 구현 기록이며 당시 미검증 상태를 보존한다.

## 범위

- `apps/android-companion`에 Android 10(API 29) 이상을 대상으로 독립 Android 앱을 추가했다. Windows Tauri 앱이나 기존 React UI를 교체하지 않는다.
- 계정 로그인/토큰 갱신, 구성원 조직 선택, 사용자 동의에 따른 활성 고객 전화번호부 동기화, Android Keystore AES-GCM 로컬 저장, 동기화 해제·로그아웃·조직 변경 시 기기 데이터 제거를 연결했다.
- `CallScreeningService`는 수신 통화를 네트워크 호출 없이 즉시 허용한다. 로컬 번호부와 일치하면 잠금 화면에 PII를 표시하지 않는 알림을 만들고 앱에서 서버 고객 재조회·통화 메모 저장으로 연결한다.
- 직접 번호 입력 및 고객 확인도 제공한다. 동일 번호의 고객은 모두 표시해 사용자가 선택한다.
- `scripts/build-android-companion.ps1`은 JDK 17/SDK 35를 확인하고, Gradle 8.10.2가 없으면 공식 배포본을 SHA-256 검증 후 내려받아 debug APK를 만든다. API 주소를 파라미터로 받는다.
- PC LAN 서버 바인딩 오버라이드를 `scripts/run-server.ps1`와 `scripts/run-app.ps1`에 추가했다. 환경 변수 `APP_API_HOST=0.0.0.0`가 지정되면 `.env` 값보다 우선하므로 기존 `run-app.cmd`로 데스크톱 앱과 API를 함께 실행할 수 있다.

## 검증 증거

- `PhoneMatcherTest.kt`에 국내/국가번호 정규화, 숨김·비정상 번호 거부, 중복 고객 반환 테스트를 추가했다.
- `pnpm --filter @business-assistant/api exec vitest run src/modules/phone/phone.test.ts src/modules/phone/routes.test.ts` — 14 tests passed.
- `pnpm --filter @business-assistant/api exec tsc --noEmit` — passed.
- `scripts/build-android-companion.ps1` PowerShell parser — syntax passed. XML manifest/layout parse is also checked.
- Android SDK와 JDK 17이 현재 작업 환경에 없어서 Gradle/Kotlin 테스트, APK 빌드, Android 실기기 설치/통화 검증은 수행하지 않았다. 해당 범위는 `verified`가 아니다.
- 실제 휴대폰 테스트 명령과 순서는 [안드로이드 전화 연동 테스트](../../guides/android-phone-companion-test.md)로 제공한다.

## 제약 및 후속

- 실제 전화 식별은 Android 10 이상, 통화 선별 앱 역할 허용, 알림 권한, 활성 고객 번호부 동기화가 필요하다. 앱은 `READ_CONTACTS` 권한을 요청하지 않는다. Android가 통화 선별 앱에 연락처에 저장된 번호를 전달하지 않으므로 시험 발신 번호는 전화기 주소록에 저장하지 않는다.
- 서버가 PC에 있을 때 휴대폰과 PC는 같은 사설 Wi-Fi에 있어야 하며 방화벽에서 사설 네트워크만 TCP 8000을 허용해야 한다. HTTP는 debug에서만 사용한다. 공개 배포 전 HTTPS, release 서명, 개인정보/권한 검토가 필요하다.
- SDK/JDK 설치 후 빌드 스크립트와 실기기 단계를 수행하고 결과를 이어서 기록한다. Android 테스트 성공을 iOS 기능으로 간주하지 않는다.
