# INT-007 독립 전화 알림창

상태: in-progress. 2026-10-23 사용자가 실제 S23 전화가 PC 앱 내부 카드에 표시되는 화면을 제공했다. 따라서 Android→API→PC 전달은 해당 계정/매장에서 사용자 확인됨. 이번 변경은 최소화·트레이 상태에서도 고객을 알아볼 수 있는 별도 창이며, 실제 최소화/다중 모니터 전화 인수는 별도다.

## 구현

- Tauri `call-popup` 창: 메인 창과 별개, 항상 위, 작업 표시줄 제외, 메인 창이 있는 모니터 작업 영역 오른쪽 아래, 포커스 강탈 방지. 고객명·번호·메모 작성·닫기. 최근 최대 3건, 기존 2분 만료 유지.
- 320ms 아래에서 등장, 900ms 테두리 강조 3회. 같은 전화의 반복 조회는 DOM을 이동하지 않아 효과를 재시작하지 않는다. OS 동작 줄이기 설정에서는 효과 없음.
- 메모 버튼은 메인 창을 복원하고 기존 메모 작성 화면에 연결한다. 이미 열린 메모 입력은 덮어쓰지 않는다. 새 메모를 동시에 여러 개 열지는 않는다.
- 로그인 계정·조직 전환, 로그아웃·앱 잠금·언마운트 시 IPC 순서대로 초기화. 네이티브 창 실패 시 기존 앱 카드로 복구한다. 네이티브 성공 시 앱 내부 카드와 Windows 배너를 중복 표시하지 않는다.
- 고객 데이터는 메모리/로컬 IPC만 사용하고 URL·로그·디스크에 기록하지 않는다. 팝업 WebView는 세션 초기화를 실행하지 않으며, 네이티브 명령 경계에서 popup read/action 이외의 자격 증명·HTTP·파일·종료·업데이트 명령을 거부한다. 이벤트 권한도 listen/unlisten만 허용한다.
- Chromium 숨김 시 동결을 줄이기 위한 WebLock을 자격 있는 로그인·잠금 해제 상태에서만 유지한다. 실제 장시간 최소화 지연·절전 복귀는 인수 대상이다. 앱 완전 종료·로그아웃·앱 잠금에서는 전화 수신 창을 표시하지 않는다.
- 예약·할 일 Windows 기본 배너는 별도 사용자 설정이다. 켜기/테스트 버튼, 권한 거부/실패 안내를 추가했다. 기본 배너에는 고객 정보를 넣지 않는다.

## 검증

- `pnpm --dir apps/desktop-react exec vitest run src/features/phone/IncomingCallAlerts.test.tsx src/features/phone/popup-entry.test.ts src/features/settings/WindowsNotificationControl.test.tsx src/platform/tauri.test.ts src/app/App.test.tsx src/app/App.shell.test.tsx`: 6 files / 38 tests 통과.
- `cargo test --lib call_popup::tests --no-default-features`: 2 tests 통과. 만료/크기 제한과 popup의 민감 명령 거부 확인.
- `pnpm --dir apps/desktop-react build`: 타입 검사 및 프로덕션 번들 성공, `dist/call-popup.html`과 독립 JS/CSS 포함. 기존 큰 청크 경고는 유지.
- 개발 앱 자동 재빌드 및 기동 로그 확인. 중복 `run-app.cmd` 빌드는 실행 파일 사용 중 오류가 발생했으므로 재차 종료하지 않고 기존 최신 앱을 유지했다.
- 앱 내부 전화 카드의 실기기 성공은 사용자 화면 증거다. 이번 독립 창의 실제 수신/애니메이션·모니터 배율·장시간 최소화 화면 증거는 아직 없다. 자동 테스트 성공을 실환경 인수 완료로 표시하지 않는다.

SQL·Android 변경 없음. 현재 설치한 휴대폰 APK와 같은 테스트 터널을 계속 사용한다. 커밋·푸시 없음.
