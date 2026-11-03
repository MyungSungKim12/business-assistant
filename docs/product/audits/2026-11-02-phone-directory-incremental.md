# INT-006 / N1030-05 번호부 증분 동기화

2026-11-02. 선행 N1030-01~04와 SQL101~104 검증/원격 적용을 확인하고 착수했다. **로컬 구현·집중 검증 완료, 독립 검토와 주 에이전트의 SQL105 원격 적용 전이므로 `in-progress`를 유지한다.** 실제 Android 설치·전화/PC 연동·전체 테스트·원격 SQL·커밋/푸시는 수행하지 않았다.

## SQL·revision·초기화 계약

- 초안 `migrations/105_phone_directory_incremental.sql`은 기존 고객/예약/전화 원장을 바꾸지 않고 `phone_directory_state`, `phone_directory_live`, `phone_directory_changes`와 `public.phone_directory(uuid,text,integer)`를 추가한다. SQL103의 세션 검증 포함 membership helper와 SQL104의 `private.call_phone` 정규화를 사용한다. 고객 INSERT/UPDATE/DELETE trigger만 변경 projection과 로그를 유지한다. 초기 seed는 고객 테이블 변경을 막는 migration transaction 아래 한 번만 실행하며 재적용은 revision/현재 목록을 초기화하지 않는다.
- 조직별 state 행을 `FOR UPDATE`로 잠근 **뒤** revision을 증가시키고 live/log를 같은 transaction에 쓴다. 잠금은 COMMIT/ROLLBACK까지 유지된다. sequence/bigserial을 사용하지 않으므로 낮은 revision의 늦은 commit이 더 높은 확정 cursor 뒤에 숨어 누락되지 않는다. 조직 이동은 두 조직을 UUID 정렬 순서로 잠그며 이전 조직 delete + 새 조직 upsert/delete를 기록한다. 서로 다른 조직의 단일 변경은 서로 잠그지 않는다. 복수 조직/복수 고객의 복잡한 교차 transaction에서는 PostgreSQL deadlock 중단/재시도 정책이 적용되며 성공한 부분 commit은 없다.
- `active`/기존 `vip`이며 유효한 번호만 live projection에 포함한다. archive/inactive/blocked/무효 번호·고객 삭제·조직 이동은 tombstone으로 제거한다. 같은 전화번호 고객은 고객 ID별로 보존한다. 이름·전화·상태·조직·ID가 그대로인 생일/메모 수정은 번호부 revision/log를 만들지 않는다.
- cursor 없는 요청은 `snapshot` 모드다. 시작 upper revision 이하의 **현재 live 행**을 불변 고객 ID keyset으로 읽는다. 도중 변경돼 snapshot에서 제외되거나 ID 경계 이전에 새로 생긴 고객은 시작 revision 이후 delta가 복구한다. 마지막 snapshot 페이지는 항상 delta continuation을 반환하며, delta를 끝낸 뒤에만 저장 checkpoint를 발급한다. delta 시작 시 확정한 upper까지 순회하므로 지속되는 쓰기 때문에 무한 반복하지 않으며, 그 뒤 commit은 다음 자동 확인에서 읽는다.
- cursor는 `d1:<organization>:<s|d|c>:<upper revision>:<UUID keyset 또는 after revision>:<HMAC-SHA256>`다. 조직별 비공개 32-byte key와 표준 RFC2104 HMAC-SHA256을 PostgreSQL core sha256으로 계산한다(pgcrypto schema 의존 없음). Node `createHmac`과 교차 확인했다. 조직/모드/서명/미래 revision/역전 범위를 검사한다. cursor에는 고객 이름·전화번호가 없다. valid cursor 재전송은 같은 페이지를 반환하는 멱등 읽기이고, Android가 중복 continuation·revision 역전·snapshot ID 역전을 거절한다.
- 로그 보존 floor보다 오래된 snapshot/checkpoint/delta는 `reset_required:true`와 빈 items를 반환한다. 클라이언트는 임시 결과를 버리고 전체 초기화를 최대 한 번 재시도한다. `private.cleanup_phone_directory(org,keep=100000)`는 조직 잠금 아래 최대 5000개 revision 범위를 삭제하면서 floor를 원자 갱신한다. 일반 JWT/anon 호출은 금지한다. 실제 주기 cleanup 연결은 운영 후속이며 이번 작업에서 원격 스케줄러를 만들지 않았다.

## RPC·API·호환·한도

- 새 경로는 `GET /api/v1/organizations/:organizationId/mobile/phone-directory-sync?cursor=...` 하나다. 알 수 없는 수신 번호/고객 ID/임의 limit 입력을 받지 않는다. 기존 APK의 `/mobile/phone-directory` 응답과 기존 식별/메모/relay 경로는 유지한다.
- RPC 응답은 `{organization_id,mode,items,revision,next_cursor,cursor,reset_required}`다. revision은 정밀도 손실 없는 10진 문자열이다. upsert에는 `customer_id,name,phone,phone_e164`, delta에는 개별 revision을 포함한다. tombstone에는 ID/operation/revision만 의미가 있고 이전 개인정보를 반환하지 않는다. 마지막 delta에서 `next_cursor:null,cursor:<checkpoint>`, 다른 정상 페이지에서 그 반대이며 reset은 둘 다 null이다.
- API와 DB 모두 현재 사용자·조직 membership/허용 역할·유효 `crm.basic` 구독을 검사한다. API는 사용자 JWT/publishable key만 RPC로 전달한다. 테이블은 RLS enabled이고 public/anon/authenticated 직접 권한을 회수했다. 내부 signer/trigger/cleanup도 직접 호출을 회수했다. 결과의 조직/스키마/continuation 조합을 재검사하고 `Cache-Control:no-store`를 사용한다.
- RPC 최대 200개/페이지, cursor 최대 512자, 조직 행 lock timeout 2초, 함수 statement timeout 설정 5초, gateway abort 10초다. API 인스턴스당 동시 64개/계정·조직당 2개를 허용하고 finally로 반환한다. Android는 전체 500페이지/100000항목과 페이지당 200개/응답 2000000문자를 제한한다. 직렬 sync 실행 시작 후 Android elapsedRealtime 기반 120초 절대 budget을 모든 페이지·refresh·401 재시도가 공유한다. bounded executor의 timed Future.get으로 진행 중 네트워크 대기도 남은 budget까지로 제한하고, connect/read timeout도 남은 시간 이하로 줄인다. 한도/중간 실패는 정상 저장으로 처리하지 않는다. PostgreSQL statement timeout 설정의 실제 운영 PostgREST 취소/부하 동작은 실환경 인수 범위다.
- 모바일 시험 tunnel은 새 GET 읽기 경로만 추가했다. POST sync와 PC caller-profile/inbox는 차단한다. 기존 bearer 전달과 download token 경계를 유지했다.

## Android 0.5.0 (versionCode 6)

- `DirectoryDelta`/`DirectorySyncEngine`이 기존 snapshot과 변경분을 고객 ID로 병합한다. snapshot 전체 + delta 또는 기존 checkpoint 이후 delta가 모두 검증된 뒤만 최종 결과를 노출하고 저장 callback을 한 번 호출한다. tombstone과 재수신은 멱등이며 동일 번호 고객을 합치지 않는다.
- `PhoneApi.syncDirectory`는 앱 전역 sync lock/기존 WorkManager를 유지하고 새 API를 호출한다. 기존 암호화 payload에 cursor가 없으면 최초 한 번 bootstrap한다. 정상 no-change도 checkpoint 확인 후 synced_at을 갱신한다. 서버 실패/페이지 반복/범위 오류는 entries/cursor/확인 시각을 바꾸지 않는다.
- `SecurePhoneStore.saveDirectory`가 기존 `STATE_LOCK` 안에서 expected generation + 현재 매장 동의를 다시 검사한다. entries + revision + cursor + synced_at을 **하나의 AES-GCM 암호화 payload/SharedPreferences 값**으로 동기 commit한다. 실패한 disk commit이 메모리에서 새 확인 시각으로 보이지 않도록 이전 암호문도 복원하고 오류로 끝낸다. 실제 Keystore·파일시스템 오류 주입은 별도 인수다.
- 동의 철회/매장 전환/로그아웃/새 로그인은 기존 clearDirectory/clearAll의 generation 변경·요청 disconnect·큐 제거를 사용한다. 순수 engine도 각 요청 전후와 commit 직전에 generation/동의를 확인한다. 늦은 성공이 기기 데이터를 되살리지 못하도록 최종 저장에서 같은 검사를 반복한다. 기존 5분 갱신 판정, 15분 periodic WorkManager, 30분 stale relay 차단은 그대로다.

## 실패 재현·검증 증거

기능 추가 전 API 새 경로는 404(기대 200), SQL RPC는 42883 부재, Kotlin test는 새 병합 타입 부재로 컴파일 실패했다. 이후 구현과 집중 검증을 진행했다.

| 명령 | 결과·범위 |
| --- | --- |
| `pnpm --filter @business-assistant/api test src/modules/phone/directory.test.ts src/modules/phone/gateway.test.ts src/modules/phone/routes.test.ts src/modules/phone/durable-inbox.test.ts` | **25 pass**. 새 endpoint/JWT 전달·응답 조직/스키마·strict 입력·401/422/429/503·동시 한도/실패 slot 반환 및 기존 directory/VIP/번호 매칭·memo/relay 호환 |
| `pnpm --filter @business-assistant/api build` | TypeScript build pass |
| `node scripts/db-tests/phone-directory-105.mjs --api` | PGlite **PASS**. migration 재적용, HMAC 교차 검증, snapshot 중 신규/이름 변경/삭제, 동일 번호, archive/VIP/무효 번호/조직 이동, 메모 no-op, 서명/다른 조직/미래/역전 cursor, 로그 floor reset, feature/membership/anon/직접 ACL, 실제 route→gateway→SQL no-change/tampered422 |
| `node scripts/db-tests/phone-directory-105.mjs --postgres --api` | **native PostgreSQL 18.6 PASS**. 위 계약 전부 + 실제 별도 연결 3개로 A의 미commit revision 뒤 B가 같은 조직에서 잠기는 것을 `pg_stat_activity`로 확인. 그동안 다른 조직 INSERT는 commit. A commit 후 B revision 순서 일치, rollback revision 소비 없음. 로컬 127.0.0.1 임시 cluster이며 원격 데이터/서비스 접속 없음 |
| `node --test scripts/android-test-gateway.test.mjs` | **1 pass**, 새 sync GET 허용/POST 차단·PC enrichment/inbox 비노출 |
| Gradle `:app:testDebugUnitTest --tests com.businessassistant.phone.PhoneRequestDeadlineTest --tests com.businessassistant.phone.DirectoryDeltaTest --tests com.businessassistant.phone.DirectorySyncPolicyTest --tests com.businessassistant.phone.CallRelayPolicyTest --tests com.businessassistant.phone.PhoneMatcherTest :app:assembleDebug` | **21 tests, 0 failures/errors + debug APK build pass**. 초기/여러 snapshot 페이지/증분/upsert/tombstone/동일 번호/no-change/retention reset, 중간 장애 rollback·generation/동의 무효화·반복/역전/용량/시간 한도 및 기존 stale/relay/번호정규화 정책 |

native SQL 재현용 도구는 저장소 밖 `%TEMP%/business-assistant-phone-directory-105-tools`에 `embedded-postgres@18.6.0-beta.19`, `pg@8.16.3`만 설치했다. `PHONE_DIRECTORY_PG_TOOLS`를 해당 폴더로 지정하면 `--postgres`를 사용할 수 있다. Windows의 직접 postgres.exe는 관리자 token으로 시작할 수 없어 `pg_ctl`의 제한 token 시작을 사용했다. cluster는 테스트 후 종료하며 임시 테스트 자료는 해당 도구 폴더에 남는다. 저장소 package/lockfile은 변경하지 않았다.

Android 검증 환경: JDK `C:/Program Files/Java/jdk-17.0.1+12`, SDK `%LOCALAPPDATA%/Android/Sdk`, Gradle8.10.2, 기존 TCP loopback marker. 기존 SDK XML version 및 MainActivity startActivityForResult deprecation 경고는 남는다. 산출물은 `apps/android-companion/app/build/outputs/apk/debug/app-debug.apk`이고 API 주소는 이번 build의 기본 emulator 주소다. 실제 기기용 고정 주소/서명/설치는 별도다.

## 변경 파일·남은 인수

- API: `modules/phone/{routes,gateway}.ts`, 신규 `directory.test.ts`, gateway 집중 test.
- Android: `DirectoryDelta.kt`, `DirectoryDeltaTest.kt`, `PhoneRequestDeadline.kt`, `PhoneRequestDeadlineTest.kt`, `PhoneApi.kt`, `SecurePhoneStore.kt`, `app/build.gradle.kts`.
- SQL/도구: migration105, `scripts/db-tests/phone-directory-105.mjs`, mobile test gateway/시험.
- 문서: 이 audit와 integrations의 INT-006 행만 갱신했다. broad README/changelog/roadmap/상위 ledger는 주 에이전트 소유다.

화면 변경은 없으며 화면/실전화 증거는 없다. 로컬 native PostgreSQL은 최소 조직/권한/customer schema를 사용한 독립 시험이므로 실제 Supabase schema 전체·PostgREST·auth.sessions JWT 인수를 대체하지 않는다. 기기 Keystore/SharedPreferences 실제 disk failure, WorkManager 재시작·HTTP 해제, 실제 수신→PC는 검사하지 않았다. 독립 코드 검토 후 주 에이전트가 SQL105 사전 확인→원격 적용→ACL/기존 업무 건수/실제 JWT 확인을 진행해야 한다. 새 APK는 SQL105와 새 API 적용 뒤 설치한다.

설계 확인 자료: [PostgreSQL transaction row locks](https://www.postgresql.org/docs/current/explicit-locking.html), [Supabase 함수 권한/search_path](https://supabase.com/docs/guides/database/functions). Supabase changelog Markdown은 도구의 content-type 제한으로 열지 못했으며 새 Supabase SDK 기능에 의존하지 않는다.

## 독립 검토 보완 — 2026-11-02

- **조직 DELETE cascade:** 기존 최소 fixture의 customer FK가 실제 schema의 `ON DELETE CASCADE`를 빠뜨렸다. 이를 맞추고 조직+고객+번호부가 있는 부모 조직을 삭제하는 회귀를 먼저 추가해 **23503, phone_directory_state_organization_id_fkey** 실패를 재현했다. 고객 DELETE trigger에서 부모 조직이 현재 transaction에 이미 없으면 추적을 건너뛴다. 조직에 종속된 번호부 state/live/log는 각 FK cascade가 제거하며 없어진 조직에 state나 tombstone을 다시 만들지 않는다. 일반 고객 삭제와 조직 이동은 계속 revision/tombstone을 만든다. 다른 조직의 live 항목 3개 유지와 삭제한 조직의 고객/state/live/log 각각 0개를 검증했다. PGlite `--api`와 native PostgreSQL `--postgres --api` 모두 회귀/기존 계약을 통과했다.
- **실제 네트워크 대기 deadline:** 이전 120초 검사는 페이지 전후/commit 전 경계였고 `HttpURLConnection`의 8초 read timeout은 비활동 시간 제한이었다. 따라서 헤더/본문이 조금씩 계속 도착하면 한 요청이 120초를 넘는 관찰이 맞다. 새 `PhoneRequestDeadline`은 Android `elapsedRealtime`의 동일 120초 절대 budget을 sync 전체에서 사용한다. 각 page request와 그 안의 token refresh/401 재시도에 같은 객체를 전달하고 per-operation timeout을 남은 시간으로 줄인다. timed Future.get이 요청 완료를 기다리는 caller 자체를 남은 budget에 중단하므로 무한 drip/stuck HTTP로 저장 단계가 늦게 진행되지 않는다. 페이지 읽기 전후·각 read·refresh accept 전·최종 commit 전에도 deadline을 검사한다.
- 네트워크 executor는 **실행 1개 + 대기 1개**로 제한한다. timeout은 future를 취소하고 대기열에서 제거한다. JVM/OS 네트워크 호출이 interrupt를 무시하면 그 thread는 OS가 반환할 때까지 남을 수 있지만 해당 worker는 번호부를 저장하는 경로를 갖지 않는다. 늦은 응답도 deadline 검사로 버리며 후속 요청을 무제한 생성하지 않는다. 전체 앱의 JVM scheduling, sync lock 획득 대기, 이미 시작한 Keystore/SharedPreferences disk commit을 120초 안에 강제 종료한다는 보장은 하지 않는다. 번호부의 네트워크/순회 budget과 commit 진입 제한이며 OS hard real-time 보장은 아니다.
- 순수 JVM deadline 회귀 3개를 추가했다. interrupt를 무시하는 지연 작업에서도 timed wait가 종료하고 번호부 commit이 0회임을 검증하며, 모든 페이지/refresh가 공유하는 budget 감소와 성공/오류 전달도 확인한다. 해당 helper 부재의 초기 컴파일 실패를 확인한 뒤 구현했다. focused Kotlin은 **21 tests, 0 failures/errors**, APK0.5.0/code6 재빌드, API25/build와 PGlite/native SQL105를 다시 확인했다. 실제 Android HTTP/절전/Keystore 동작은 여전히 설치 기기 인수 범위다.

위 보완 후 다시 독립 재검토를 기다린다. SQL105 원격 적용과 실데이터 변경은 수행하지 않았다.
