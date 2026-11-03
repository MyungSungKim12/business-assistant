# INT-007 Android 수신 → PC 고객 알림 — 2026-10-21

## 사용자 요구와 수정 범위

사용자는 휴대폰 자체 알림이 아니라 PC 프로그램에 발신 고객이 표시되기를 요청했다. INT-005/006에서 빠진 전달 범위를 INT-007로 분리해 구현했다. Android 0.2.0은 휴대폰 고객 알림을 제거하고 별도 PC 전송 동의를 받는다. 자동 고객 활동/가공 통화 이력은 만들지 않는다.

## 구현

- Android: 즉시 통화 허용 → 암호화 로컬 번호부 정확 일치 → PC 전송 동의 확인 → 암호화 payload와 WorkManager 이벤트 ID 예약 → 서버 전송. WorkManager 데이터에는 번호/이름/토큰을 저장하지 않는다. 연락처 권한은 여전히 선택이며 연락처 DB를 읽거나 업로드하지 않는다.
- 2분 만료, 임시 네트워크/429/5xx 재시도, 인증/검증/권한 오류 중단, 동일 통화 UUID 중복 방지. 동기화 해제·로그아웃·조직 변경으로 로컬 큐/동의를 지우고 generation이 바뀌면 기존 worker의 갱신 토큰 저장도 차단한다. 로그인 성공 시 이전 번호부와 전송 동의를 해제한다.
- API: `POST/GET /organizations/:id/mobile/incoming-calls`. JWT는 기존 Supabase getUser로 검증한 subject를 사용하고 매 요청 crm.basic 조직 접근을 검사한다. 요청 본문 actor는 받지 않는다. 서버에서 활성 고객 정확 번호를 재확인하며 같은 계정/조직으로만 전달한다. 8초 long-poll, event UUID 멱등, 내용이 달라진 UUID 재사용 거부, 계정·조직별 100건/전체 1000 범위/범위당 대기 4건 한도를 둔다.
- PC: 전역 오른쪽 아래 고객 카드, 고객 중복 시 복수 결과, 선택 메모, 새 전화 중 기존 메모 보존, 실패 시 입력 보존, 잠금 중 조회/개인정보 표시 중지 및 기존 메모 유지, 로그아웃/조직 변경의 오래된 응답 폐기. 작성 중 메모는 이동/종료 보호에 포함한다. 선택 Windows 알림은 고객 이름/번호를 숨긴다.
- 임시 HTTPS 게이트웨이는 휴대폰의 이벤트 POST만 추가 허용한다. PC 조회 GET은 외부에 노출하지 않는다. 새 APK와 내려받은 파일의 해시를 대조한다.

## 집중 검증

- API: `pnpm --filter @business-assistant/api exec vitest run src/modules/phone/incoming-calls.test.ts src/modules/phone/routes.test.ts src/modules/phone/phone.test.ts` — 21 tests passed.
- API: `pnpm --filter @business-assistant/api exec tsc --noEmit` — passed.
- PC: `pnpm --filter @business-assistant/desktop-react exec vitest run src/features/phone/IncomingCallAlerts.test.tsx src/features/customers/PhoneMemoDialog.test.tsx src/app/App.test.tsx src/app/App.shell.test.tsx` — 27 tests passed.
- PC: `pnpm --filter @business-assistant/desktop-react exec tsc -b --pretty false` — passed.
- Native 경로: `pnpm --filter @business-assistant/desktop-react exec vitest run src/platform/tauri.test.ts` — 8 tests passed. 이벤트 long-poll 대기 중 기존 online 상태를 유지하는 회귀를 포함한다.
- Android: `build-android-companion.ps1 -ApiBaseUrl <현재 임시 HTTPS>/api/v1/ -UseTcpLoopback -Test` — BUILD SUCCESSFUL. PhoneMatcher 3 + CallRelayPolicy 3 tests, failures/errors 0. aapt versionCode=3/versionName=0.2.0 확인.
- 게이트웨이: `node --test scripts/android-test-gateway.test.mjs` — 1 test passed. HTTPS health=200, 미인증 이벤트 POST=401, 내려받은 APK SHA-256 일치 확인.
- 실제 S23 통화와 PC 화면 인수, 폰 권한 철회/백그라운드 작업 수명주기는 미검증이다. 전체 테스트는 실행하지 않았다. 커밋/푸시/실 DB 변경 없음.

## 제한 및 다음 단계

현재 사용자의 요청에 맞춘 단일 PC API 실시간 시험이다. 서버 메모리의 이벤트는 통화 시각 기준 최대 2분만 유지하고 프로세스 재시작 시 지워진다. PC가 미접속인 동안의 수신 내역 보존, 다중 API 인스턴스 공유 저장/전달, Android 기기 장기 오프라인 보존은 제공하지 않는다. WorkManager 전달은 OS 자원/배터리 제한에 영향을 받으며 초 단위 즉시 전달을 보증하지 않는다. 기존 전화 메모 API의 저장 결과 불명확 후 중복 방지 강화는 별도 후속이다. 최종 상품화 시 내구성 있는 이벤트 전달·수신 기기 관리와 보존 정책을 설계해야 한다.

상태는 `in-progress`로 유지하고 S23 실통화 → PC 표시 → 메모 저장 인수 결과를 추가한다. 실행 가이드는 [Android PC 전화 테스트](../../guides/android-phone-companion-test.md)를 따른다.
