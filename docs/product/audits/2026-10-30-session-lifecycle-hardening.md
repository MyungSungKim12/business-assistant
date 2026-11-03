# SEC-14 / R1030-01 PC 세션 경계 보완

2026-10-30 · 상태: verified (현재 PC ApiClient의 로컬 집중 검증 범위). 원격 세션 폐기/기기 관리와 실제 설치본 Keyring 인수는 별도다.

## 문제와 수정

점검에서 login → 보호 요청 401 → refresh 대기 → logout → 늦은 refresh 반환 순서로, 토큰이 재저장되고 이전 요청이 다시 전송되는 것을 재현했다. 실패 테스트 7개를 먼저 실행해 모두 실패함을 확인한 뒤 수정했다.

- 로그인/회원가입/로그아웃마다 세션 generation을 변경한다. 이전 generation의 성공/실패 응답은 `SESSION_CHANGED`로 거부하고 재시도하지 않는다. 정상 조회뿐 아니라 void 변경 요청도 같은 경계를 사용한다.
- 과거 refresh의 실패가 새 계정의 메모리/저장 토큰을 지우지 않게 한다. 이전 refresh/admin 확인 promise의 정리도 새 promise를 제거하지 않도록 identity를 비교한다.
- 토큰 저장/삭제는 하나의 queue로 직렬화한다. 이미 실행 중인 저장이 완료되면 다음 logout 삭제가 이어지고, logout 완료 시 이전 저장 토큰이 남지 않도록 한다. 저장 실패도 뒤의 삭제를 막지 않는다.
- 세션은 토큰 저장을 마친 뒤 현재 generation임을 재확인하고 메모리에 적용한다. 새 로그인 시작 시 이전 토큰을 정리하고, refresh token이 없는 세션도 이전 토큰을 남기지 않는다.
- 동시 401의 단일 refresh를 유지한다. 동시에 실행된 시작 복원도 refresh를 공유한다. 일시적 429/5xx에서 저장 토큰을 보존하는 기존 동작을 유지한다.
- 화면/서버 API/DB/Android에는 변경이 없다. 이미 서버가 받은 업무 요청을 소급 취소하거나 서버의 전체 세션을 폐기하지 않는다. 이 기능은 SET-003 후속 기기/세션 관리 범위다.

## 검증

명령:

```powershell
pnpm --dir apps/desktop-react exec vitest run src/api/client.test.ts src/api/clientSecurity.test.ts src/api/clientPlatformAdmin.test.ts src/app/App.test.tsx src/app/App.shell.test.tsx src/app/useTrayActions.test.tsx src/app/LockScreen.test.tsx
pnpm --dir apps/desktop-react build
git diff --check
```

- 집중 7 files / 61 tests 통과.
- Client 자체 24 tests: 기존 로그인/동시 refresh/401/403/오류 처리 외 늦은 refresh 200/401/503, 새 계정 전환, 늦은 login/signup/조회/void 응답, 지연 token save와 logout, 지연 token load와 새 로그인, 동시 복원, 저장 실패 후 삭제를 검증했다.
- PC 타입 검사/프로덕션 빌드 성공. 기존 큰 청크 경고는 유지한다. diff 공백 오류 없음(CRLF 안내만 표시).
- 가짜 토큰/응답과 저장소로 재현했다. 원격 인증/실데이터·전체 테스트·앱 기동·커밋/푸시 없음. 시각 변화가 없으므로 화면 증거는 해당 없음. Native Credential의 실제 OS 동작은 인수 대상이다.

이 항목의 코드/집중 검증은 완료했다. 다음 순서는 R1030-02의 상한 있는 고객·범용 목록 조회를 화면별 서버 검색/완전 조회/집계로 연결하는 작업이다.
