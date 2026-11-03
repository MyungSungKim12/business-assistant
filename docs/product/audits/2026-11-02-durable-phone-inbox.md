# INT-007 / N1030-04 영속 전화 수신함

2026-11-02. 기존 1~3번과 SQL101~103의 검증을 선행 조건으로 삼았다. 이번 작업은 로컬 구현·집중 검증 범위다. **SQL104 원격 적용과 독립 검토는 주 에이전트에게 넘기며, 실제 앱·전화·전체 테스트·커밋·푸시는 수행하지 않았다.** INT-007은 이 인수가 남아 `in-progress`를 유지한다.

## 구현 계약

- `104_durable_phone_inbox.sql`은 `phone_inbox_channels`, `phone_call_events`, `phone_inbox_operations`와 `public.phone_inbox(uuid,text,jsonb)` RPC를 추가한다. 기존 업무 행을 변환하거나 삭제하지 않는다. 사용자 JWT와 hardened `private.has_organization_role`(103), 현재 `crm.basic` 구독을 DB와 API 양쪽에서 검사한다. 콜백 생성에는 `task.basic`도 검사한다.
- 생산 API의 `CallRelayStore` 의존을 없앴다. 해당 메모리 코드는 기존 단위 시험용 `relay-test-store.ts`에만 남는다. DB 연결 실패를 임시 성공으로 돌리지 않는다. 개별 gateway가 같은 RPC를 읽으므로 재생성·다중 인스턴스에서도 이벤트/cursor를 공유한다. 대기 중에는 500ms 간격으로 DB를 확인하며 메모리 wake-up에 의존하지 않는다.
- 전달은 수신자의 **같은 계정·조직**으로 한정한다. 보관 수신함은 본인 수신 또는 명시적 배정 기록만 읽거나 수정한다. 소유자·관리자에게도 전체 전화 자동 방송/자동 열람을 추가하지 않았다. 배정은 현재 같은 조직의 membership과 허용 역할을 확인한다. 현재 membership 모델에 별도 `active` 열은 없으므로 membership 존재/역할이 활성 기준이다.
- 수신 입력은 event ID·번호·발생 시각과 선택 보관 동의 버전뿐이다. DB가 번호를 정규화해 해당 조직 `active`/기존 `vip` 고객과 정확히 비교한다. 임의 이름·customer matches·user/organization 주입은 strict 입력에서 거절한다. 최대 100개의 일치 고객만 저장하며 101명 이상이면 거절한다. 정규화 식 인덱스의 순수 함수는 고객 INSERT/UPDATE 때 실행되어야 하므로 authenticated에 EXECUTE를 허용한다. 이 함수는 입력 문자열만 계산하고 테이블을 읽지 않는다.
- 보관 데이터는 당시 번호·시각·일치 고객 ID·응대 상태·담당·연결 task ID·버전이다. 고객 이름/프로필 메모·사진을 복제하지 않고 조회 시 현재 고객을 가져온다. 멱등 작업의 입력은 SHA-256 지문으로 보존해 메모 원문을 작업 ledger에 재복제하지 않는다. 원문 번호 테이블은 RLS 활성화 + 직접 권한 회수로 차단하고 검사된 RPC로만 노출한다. 수신함 표시는 항상 `maskPhone`을 사용한다.

## 동의·보유·호환

- 기존 APK의 요청에는 보관 동의 버전이 없으므로 서버가 재생성돼도 **최근 2분 실시간 알림**만 복구한다. PC/번호부 동의만으로 30일 보관을 켜지 않는다. 2분 만료는 실제 부재중/통화 종료/응대 완료를 뜻하지 않는다.
- Android 소스 0.4.0(versionCode 5)에 별도 선택 동의·기본 꺼짐·30일 안내를 추가했다. 자신의 서버 보관 동의 버전을 발급받고, 실제 수신 당시 기기 큐에 그 버전을 고정한다. 나중에 동의한 재시도가 이전 전화에 동의를 소급하지 못한다. 서버도 현재 수신자 동의 enabled/버전이 정확히 일치할 때만 30일 보관한다.
- 동의 철회 후 새 수신은 실시간 2분 범위로 제한한다. 이미 보관한 기록은 원래 발생 시각 + 30일에 만료한다. 사용자가 저장한 고객 활동·tasks는 해당 업무 원장으로 유지한다. API/Android/수신함에 이 구분을 안내한다.
- 기기 보관/PC 동의 철회·번호부 삭제·로그아웃·매장 전환은 큐/세대와 진행 중 HTTP 연결을 무효화한다. HTTP가 이미 서버에서 승인된 기록을 소급 취소한다는 보장은 하지 않는다. 보관 철회는 서버 반영 뒤 새 보관을 막는다. 오프라인 로컬 철회는 즉시 효력이 있고, 서버 반영 실패는 실제 성공으로 표시하지 않으며 별도 철회 재시도 버튼을 제공한다.
- PC 설정은 서버의 보관 동의를 실시간 알림 설정과 별도로 표시한다. 수신함에서 철회할 수 있고 새 APK에서 선택적으로 켠다. APK 설치/실기기 인수는 수행하지 않았다.

## 응대·복구·경계

- 더보기의 전화 수신함에서 날짜(KST)/고객/상태 필터, 제한 페이지, 조회 오류·권한/재시도, 현재 고객 메모·주의사항과 고객 상세 이동을 제공한다. 직원 목록 조회 실패도 표시하며 기존 담당을 조용히 지우지 않는다.
- 상태는 `unconfirmed`/`seen`/`completed`/`callback_needed`다. 카드 열기/수락 후 Native ACK는 미확인만 확인으로 바꾼다. 이미 완료된 상태를 확인으로 되돌리지 않는다. 완료는 사용자의 명시적 저장이다. 알림창의 수락 후 닫기 순서는 유지한다.
- 응대 메모·상태·담당·콜백은 expected version + operation ID를 사용한다. 동일 작업 재시도는 원래 결과를 반환하고 내용이 다르면 409, 다른 처리의 오래된 버전도 409다. 기록별 DB 잠금으로 활동/task와 상태 변경을 원자 처리한다. 연결된 콜백 task가 있으면 같은 기록에서 또 만들지 않는다. task 생성 자체를 실제 통화 완료로 간주하지 않는다.
- 이력 메모는 당시 저장된 customer ID 배열과 현재 같은 조직의 active/vip 고객 존재를 검사한다. 현재 번호가 바뀌어도 당시 연결 고객에게 기록한다. 기존 수동 번호 조회/메모 API는 현재 번호의 정확 일치를 계속 요구한다. Native 전화 메모도 보관 기록이 있으면 이 버전/멱등 경로를 쓰고, 보관하지 않은 전화일 때 기존 수동 경로를 사용한다.
- 편집 실패/충돌에서 메모를 보존하고 불확실한 재시도에는 같은 operation/version을 쓴다. 메뉴·고객 이동·닫기·종료는 공통 DraftBoundary와 기존 앱 이탈 보호에 연결하며 저장 중에는 입력/닫기를 막는다. 충돌은 최신 기록을 명시적으로 불러와야 다시 저장할 수 있다.
- poll/list 최대 100건, UI 30건. long poll은 수신자당 4개/인스턴스 전체 256개, 대기 8초다. 새 cursor는 `v1:<수신자 채널 UUID>:<sequence>`로 조직·계정에 고정되며 다른 범위 cursor/미래 poll cursor를 거절한다. 이전 메모리 `epoch:sequence`는 poll만 처음부터 재조회한다. 채널 high-water mark를 남겨 이벤트 정리 뒤의 정상 cursor도 유효하다. 재전송 dedupe/conflict는 해당 이벤트의 보유기간 안에서 보장하며 삭제된 이벤트 ID의 영구 tombstone은 남기지 않는다.
- 만료 기록은 조회에서 즉시 제외한다. `private.cleanup_phone_inbox(1..5000)`는 제한 배치·SKIP LOCKED로 만료 이벤트와 종속 operation만 제거한다. anon/authenticated 호출 권한은 없으며 실제 scheduler 연결은 후속 유지보수 작업이다. 기존 고객 활동·시술·매출·tasks를 삭제하지 않는다.

## 실패 재현과 검증

초기 실패: DB가 없는데 기존 relay가 201을 반환함(기대 503), 보관 동의 endpoint가 없음(404), 메뉴에 전화 수신함 없음. 새 SQL RPC 부재도 격리 엔진에서 재현했다. Kotlin history consent 고정 정책 부재를 컴파일 검증에서 확인한 뒤 구현했다. 추가로 정규화 인덱스의 함수 권한 때문에 고객 INSERT가 막히는 문제를 격리 DB에서 재현하고 순수 함수 EXECUTE 권한을 보완했다.

| 검증 명령 | 결과·범위 |
| --- | --- |
| `pnpm --filter @business-assistant/api test src/modules/phone/gateway.test.ts src/modules/phone/incoming-calls.test.ts src/modules/phone/routes.test.ts src/modules/phone/durable-inbox.test.ts` | **23 tests pass**. JWT 전달/응답 조직 검증, DB 장애 실패 처리, 오류 매핑, 수신자 분리, 입력/시각·현재 번호 정확 일치 호환, 네 listener 한도/해제 |
| `node scripts/db-tests/phone-inbox-104.mjs --api` (API build 후) | **PASS**. SQL 재적용, 기본/선택/철회·이전 전화 소급 보관 거부, 보관기간, 자기/배정/다른 조직·계정·익명·직접 테이블 권한, 안정 cursor/이전 cursor/정리 후 cursor, 버전·멱등/내용 충돌, 현재 연락처 변경 뒤 이력 메모, task entitlement 실패 시 부분 기록 없음, 활동/task 한 번 생성, 완료 ACK 보존, 만료/제한 정리와 원장 보존, 정리 전 만료 이벤트의 동일 재전송 404·상이 내용 409와 고객 정보 비노출. 독립 실제 gateway/App 두 개를 같은 PGlite RPC에 연결한 동시 publish/다른 인스턴스 poll/앱 재생성 복구 통과 |
| `pnpm --filter @business-assistant/desktop-react test src/features/phone/PhoneInboxPage.test.tsx src/features/phone/phoneInboxMenu.test.ts src/features/customers/PhoneMemoDialog.test.tsx src/features/phone/IncomingCallAlerts.test.tsx src/features/settings/SettingsDialog.test.tsx` | **24 tests pass**. 메뉴/마스킹/확인과 완료 구분, 실패/충돌 입력·동일 작업 재시도, 저장 중 이탈/필드 보호, 권한 오류/재시도·날짜/상태/페이지, Native ACK 호환, durable memo의 수동 경로 중복 방지, 설정 상태 |
| `node --test scripts/android-test-gateway.test.mjs` | **1 pass**. 모바일 보관 동의 GET/PUT만 추가 허용, PC 수신함은 tunnel에 노출하지 않음 |
| Gradle `:app:testDebugUnitTest --tests com.businessassistant.phone.CallRelayPolicyTest --tests com.businessassistant.phone.DirectorySyncPolicyTest --tests com.businessassistant.phone.PhoneMatcherTest` | **10 tests, 0 failures/errors**, 앱 소스/리소스 컴파일 성공. JDK `C:/Program Files/Java/jdk-17.0.1+12`, SDK `%LOCALAPPDATA%/Android/Sdk`, Gradle 8.10.2, 기존 TCP loopback marker 사용. SDK XML 버전/기존 startActivityForResult deprecation 경고는 남음. Android Studio JBR25는 Gradle 시작 단계에서 `25.0.3` 실패하여 설치된 JDK17로 전환 |
| `pnpm --filter @business-assistant/api build`, `pnpm --filter @business-assistant/desktop-react build`, 별도 `tsc -b` | 통과. 기존 desktop bundle 500kB 경고는 남음 |

화면 증거는 Testing Library DOM 검증이며 실제 스크린샷/앱 실행 증거는 없다. PGlite는 독립 DB이지만 membership/session/subscription/customer/task/activity의 최소 테스트 schema를 사용한다. 실제 Supabase PostgREST·auth.sessions·다중 OS 프로세스·HTTP 단절/Keystore/WorkManager/연락처 권한은 이 검증으로 인수하지 않았다. 두 개 독립 gateway/App 객체의 검증을 실제 두 서버 프로세스 시험으로 과장하지 않는다.

## 변경 파일·다음 단계

- API: `apps/api/src/app.ts`, `modules/phone/{routes,incoming-calls,gateway,relay-test-store}.ts`와 집중 tests. 1~3번 코드의 실질 변경은 없고 app dependency wiring에 phone만 추가했다.
- PC: `src/api/{client,phoneInbox}`, `app/{Workspace,routes,services}`, shell `TopBar/menuCatalog`, phone `PhoneInboxPage/IncomingCallAlerts`, customers `PhoneMemoDialog`, settings `SettingsDialog/PhoneRetentionStatus` 및 집중 tests.
- Android: `app/build.gradle.kts`, `activity_main.xml`, `MainActivity/PhoneApi/SecurePhoneStore/CallRelayPolicy/call/CallRelayWorker`와 `CallRelayPolicyTest`.
- SQL/도구: migration104, `scripts/db-tests/phone-inbox-104.mjs`, 모바일 test gateway와 그 시험. 기존 작업 트리를 초기화하거나 커밋하지 않았다.

주 에이전트의 독립 보안/제품 검토 후 SQL104를 원격 사전 점검→적용→함수/테이블 ACL·현재 JWT 경계·기존 업무 건수 확인 순서로 진행한다. API는 SQL104 적용 후 재시작해야 한다. 신규 APK의 실제 배포/설치와 Android→Native PC→수신함/콜백, 다중 서버 프로세스, 보관 청소 scheduler의 운영 인수는 별도다.

보안 설계 확인 자료: [Supabase 함수 권한/search_path](https://supabase.com/docs/guides/database/functions), [RLS와 definer 경계](https://supabase.com/docs/guides/database/postgres/row-level-security). changelog Markdown은 브라우저 도구의 content-type 제한으로 열지 못했으며 새 SDK/서비스 기능에 의존하는 변경은 하지 않았다.

## 독립 검토 보완 — 2026-11-02

- 리뷰에서 `publish`의 기존 이벤트 재전송 분기만 논리 만료 검사를 거치지 않아 cleanup 이전의 만료된 30일 기록에서 고객 matches를 반환하는 문제를 재현했다. 격리 회귀를 먼저 추가해 `Missing expected rejection` 실패를 확인했다. SQL104는 기존 번호/시각 충돌 검사를 유지한 뒤 보유 만료를 검사한다. **동일 내용의 만료 재전송은 P0002 → HTTP404**로 끝나며 이벤트/번호/고객 matches를 반환하지 않는다. 다른 내용으로 같은 ID를 재사용하면 기존과 같이409이고 행 삽입/만료 연장은 없다. 만료된 비보관 2분 이벤트에도 같은 정책을 적용하며 poll도 retained_until을 명시적으로 검사한다. `node scripts/db-tests/phone-inbox-104.mjs --api`와 관련 API23 tests를 재실행해 통과했다.
- 리뷰에서 Native 전화 메모의 durable 저장 대기 중 textarea/번호/고객 선택이 편집 가능하고 성공 시 닫혀 새 입력을 버리는 문제를 재현했다. 지연 응답 테스트에서 disabled 기대가 실패함을 확인한 뒤, 조회/저장 중 번호·고객 fieldset·메모를 모두 비활성화했다. 전송 원문이 유지되고 성공 전에 닫히지 않으며, 해당 요청이 끝난 뒤만 닫히는 회귀를 추가했다. 관련 React5 files **24 tests pass**, TypeScript 검사를 수행했다. 이 수정은 저장된 요청을 바꾸거나 다른 작업 범위를 확장하지 않는다.
- 위 보완 후 코드가 다시 동결됐으며 주 에이전트의 두 번째 검토를 기다린다. SQL104는 여전히 원격 미적용이다.

## 재검토·SQL104 원격 적용 (2026-11-02)

- 독립 재검토는 위 두 보완을 승인했다. SQL104는 정리 전에 만료된 동일 이벤트 재시도를 404로 끝내며 전화번호/고객 일치 정보를 반환하지 않는다. 변경된 재시도 내용은 409로 남고, poll도 retained_until을 검사한다. 저장 중 Native 메모의 전화번호·고객 선택·문장은 비활성화되어 대기 중 새 입력을 잃지 않는다.
- 최종 집중 확인은 API23, React24, Kotlin10, API/Desktop build·typecheck와 격리 SQL104 통과. Android의 실제 기기/HTTP lifecycle은 검증하지 않았다.
- Supabase `business-assistant`에 `104_durable_phone_inbox` 적용 성공(version `20261102062807`). 적용 전후 auth.sessions57행·customers19·appointments23·memberships1 유지. 전화 관련 테이블 3개는 RLS enabled, authenticated/anon 직접 SELECT false, phone RPC는 authenticated execute true/anon false, 내부 정리 RPC는 authenticated false. 적용 후 channel/event/operation 각각 0행이며 실전화 기록을 추가하지 않았다.
- Post-apply Advisor: RLS enabled/no policy INFO 5건(예약 정책 2 + 전화 inbox RPC 전용 테이블 3), authenticated SECURITY DEFINER WARN 127건(기존 126 + 의도된 phone RPC), leaked password protection WARN 1건. 전화 테이블은 직접 권한을 회수했으므로 무정책 RLS 구조는 의도된 상태. [RLS lint 안내](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy), [SECURITY DEFINER lint 안내](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [유출 비밀번호 보호 안내](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).
- 남은 인수: 최신 API로 재시작 후 S23의 신규 0.4.0 빌드, 실제 Supabase user JWT, 전화→Native PC popup→수신함/메모/콜백/철회, 별도 API OS 프로세스, 실제 만료 정리 scheduler. 지금까지의 PGlite 다중 gateway 테스트는 실서버 시험이 아니다.
