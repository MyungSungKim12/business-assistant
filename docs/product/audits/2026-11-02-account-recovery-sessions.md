# N1030-03 / SET-003 계정 복구·세션 감사 기록

날짜: 2026-11-02. 선행: N1030-01(101), N1030-02(102, 원격 버전 20261102005828). 범위는 계정 복구/확인 메일 재요청, 서버 제공 비밀번호 재설정, 본인 Auth 세션 조회·선택/전체 해제다. 초대·퇴사·역할 설정 전체 완료를 뜻하지 않는다.

## 구현 경계와 실제 동선

- 로그인 화면의 이메일 입력을 유지하며 ‘비밀번호 찾기’와 ‘확인 메일 재전송’을 제공한다. 비밀번호 입력이나 로그인 시도 없이 요청한다. 이메일/유형/추가 필드를 서버에서 검사한다.
- 실제 런타임 `apps/api/src/supabase/runtime-auth.ts`에서 Supabase `resetPasswordForEmail`/`resend(type: signup)`를 연결했다. 축소 gateway만 바꾼 구현이 아니다. 계정 미존재·확인 완료·계정별 메일 재발송 대기 상태는 같은 조건부 안내로 처리하며, 고정 redirect/로컬 기능 미설정은 503이다. 공급자 발송 오류는 계정 열거를 막기 위해 동일한 delivery_confirmed:false 조건부 응답을 반환하며 서버 운영 경고로 관찰한다. 메일 수신 성공을 보장하는 문구를 쓰지 않는다.
- 기존 AuthGuard로 IP·IP+이메일·전체 이메일별 발송 요청 제한을 적용한다. 이메일은 HMAC 키로 메모리에 저장하며 기본 회원가입 제한(5회/3600초)을 공유한다. 이 제한은 기존 구조대로 프로세스별이므로 여러 인스턴스 합산은 공급자 제한/외부 공유 제한 운영 설정이 필요하다.
- PC의 deep-link 처리 대신 API의 `/account/recovery`와 `/account/recovery.js`가 메일 복구 화면을 제공한다. 링크 fragment의 access token은 메모리에서만 사용하며 URL을 즉시 교체한다. refresh token을 저장/전송하지 않는다. 새 비밀번호/확인(8~200자), 재시도, 만료 안내, 성공 후 앱 재로그인을 제공한다. 작성 중 종료 경고, 실패 시 입력 보존을 적용했다.
- 복구 화면은 no-store/no-referrer, 외부 리소스 차단 CSP(script/connect self, frame/form/base 차단), X-Frame-Options DENY를 사용한다. HTML/JS에 키나 사용자 값을 삽입하지 않는다.
- 설정의 ‘계정 · 로그인 기기’는 Auth의 실제 세션 정보만 표시한다. user_agent가 없으면 ‘알 수 없는 기기’, 최근 갱신이 없으면 ‘기록 없음’이다. IP·refresh secret·설치 ID·임의 기기 이름은 반환/표시하지 않는다. 목록은 50개 keyset 페이지와 ‘더 보기’를 제공한다.
- 현재/전체 해제 시 기존 미저장 입력 확인을 거친다. 해제 실패 시 목록과 재시도 동선을 유지한다. 현재 해제 성공 시 ApiClient의 기존 generation 및 token write queue로 로컬 토큰을 제거하고 로그인으로 돌아간다.
- 일반 로그아웃도 `/auth/logout`으로 현재 실제 서버 세션을 해제한다. 로컬 generation/토큰 정리를 먼저 수행하고, 서버 연결 실패 시 로컬 로그아웃과 원격 해제 불확실성을 구분해 안내한다. 서버 401도 현재 세션 해제 확인으로 단정하지 않으며, 만료 JWT로 실제 refresh 가능 세션이 남았을 가능성을 안내한다.

## API/설정/호출자 계약

| 경로 | 계약 |
| --- | --- |
| POST `/api/v1/auth/email` | 익명 `{email, type: recovery\|signup}` strict. 임의 redirect 금지. 접수 `{message: 조건부 동일 안내,delivery_confirmed:false}`. 검증 422, 요청 제한 429, 로컬 설정 실패 503. 공급자 발송 장애는 동일 접수 응답+운영 로그 |
| POST `/api/v1/auth/password` | 유효한 bearer + `{password}` strict. 실제 세션 확인 후 Auth PUT `/user`로 변경하고 본인 세션 해제. `{password_changed:true,session_cleanup_pending:boolean}` |
| GET `/api/v1/auth/sessions?cursor=UUID` | bearer. `list_account_sessions(p_cursor,p_limit:50)` 결과 반환 |
| POST `/api/v1/auth/sessions/revoke` | bearer + `{session_id: UUID\|null}` strict. null은 본인 전체. `{revoked_count,current_revoked}` |
| POST `/api/v1/auth/logout` | bearer. 유효한 현재 세션 확인 후 JWT session_id의 본인 세션만 해제 |

`APP_AUTH_RECOVERY_URL`은 서버에 설정하는 고정 URL이며 정확한 `/account/recovery` 경로, HTTPS, 사용자정보/query/fragment 없음이 필요하다. 미설정 시 발송 503이다. 명시적 `APP_AUTH_ALLOW_LOOPBACK_RECOVERY=true`일 때만 개발 HTTP localhost/127.0.0.1/::1 예외를 허용하고 운영 환경 파서는 해당 플래그를 거부한다. `.env.example`에 안내했다. Supabase Auth Redirect URLs에도 정확한 URL 등록, SMTP/발신 도메인 연결 및 공개 HTTPS API 주소가 별도로 필요하다. 이것들이 연결됐다고 주장하지 않는다.

`AuthGateway`의 선택 인터페이스는 `sendAccountEmail`, `resetPassword`, `assertSession`, `listSessions(token,cursor?)`, `revokeSessions`, `logout`이다. 실제 createRuntimeAuth는 모두 구현한다. AppApi/ApiClient는 `sendAccountEmail`, `listAccountSessions(cursor?)`, `revokeAccountSessions`로 연결했다. 주입용 기존 테스트/미리보기 gateway와 호환되도록 인터페이스 추가 필드는 선택이다.

## SQL/권한 경계

SQL103 및 격리 PostgreSQL 검증은 부모 작업에서 소유한다: `migrations/103_account_recovery_sessions.sql`. RPC 계약:

- `assert_current_session()` → true 또는 잘못된 현재 세션 SQLSTATE 28000. API는 401로 처리한다. 응답이 true가 아니면 503으로 닫는다.
- `list_account_sessions(p_cursor uuid default null,p_limit integer default 50)` → `{current_session_id,items:[{session_id,created_at,last_active_at,user_agent,is_current}],total,next_cursor}`. 자신의 세션만 조회한다.
- `revoke_account_sessions(p_session_id uuid default null)` → `{revoked_count,current_revoked}`. 다른 사용자의 존재하는 대상은 42501→403, 미존재 대상은 멱등 0. 실제 `auth.sessions` 제거와 refresh_tokens/mfa_amr FK CASCADE를 사용한다.
- `private.is_account_session_active()` 및 기존 조직 역할 helper 보강으로 직접 Data API 업무 RPC에서도 폐기 JWT를 거부한다. 공개 업무 API는 별도 전역 preHandler에서 매 요청 `assert_current_session`를 확인하므로 기존 조직 접근 캐시가 인증 폐기를 복구하지 않는다. 별도 관리자 API에도 publishable-key 기반 검사 hook을 넣었다.
- 공개 예외는 login/signup/refresh/email/health/readiness와 복구 HTML/JS다. 비밀번호 변경과 `/me`, 세션 관리 및 업무 API는 예외가 아니다. 공급자/네트워크 일시 장애를 세션 오류로 일괄 변환하지 않고 503을 보존한다.

부모의 SQL/격리검증·원격 적용 결과는 별도 보완한다. 이 하위 작업은 원격 DB 쓰기/실제 인증 세션 조회·삭제를 수행하지 않았다.

## 집중 검증

처음 추가한 `src/routes/account.test.ts`를 실행해 미구현 `/auth/email`의 404로 2개 실패를 확인한 뒤 구현했다. 기존 세션 generation 경계 테스트는 새 명시적 logout 요청을 business 요청으로 세던 mock을 `/auth/logout` 전용 응답으로 보완했다. 실제 검증을 제거하지 않았다.

실행 결과:

- `pnpm --filter @business-assistant/api test src/routes/recovery-page.test.ts src/routes/account.test.ts src/supabase/runtime-auth.account.test.ts src/admin-app.test.ts src/security/auth-guard.test.ts src/routes/auth.test.ts`: **6 files / 37 tests passed**.
- `pnpm --filter @business-assistant/desktop-react test src/api/clientAccount.test.ts src/api/client.test.ts src/api/clientSecurity.test.ts src/features/settings/AccountSessions.test.tsx src/features/auth/auth.test.tsx`: **5 files / 37 tests passed**.
- `pnpm --filter @business-assistant/api build`: passed.
- `pnpm --filter @business-assistant/desktop-react exec tsc -p tsconfig.app.json --noEmit`: passed.

API mock 테스트: strict 입력/임의 redirect, 미설정 서비스, 이메일 제한, 폐기 세션의 업무 처리 전 거부, 복구 CSP/cache/referrer, 고정 redirect/loopback, 계정 상태와 장애 분리, 실제 runtime adapter PUT password와 revoke 순서. VM 테스트: fragment 제거, token 누락/확인 링크, 새 비밀번호 확인, 네트워크 실패 후 재시도, 만료 안내. React: 이메일 실패 후 입력 보존/확인 재전송, 실제 세션 fallback·실패 재시도·전체 로그아웃, 작성 취소 보호. ApiClient: 로그아웃 시 원격 실패 전 local token 정리, 현재 해제 후 중복 요청 방지, 기존 late login/refresh/keyring 쓰기 경계 회귀.

실제 앱 실행·화면 캡처·SMTP 실발송·공개 도메인/설치본·실제 계정 비밀번호 변경/세션 삭제·전체 제품 테스트는 수행하지 않았다. 따라서 화면 증거는 자동 DOM/VM 검사이며 실제 화면 캡처가 아니다. 실제 전달/복구 링크와 Native Keyring 실기기 인수는 외부 연결 후 남는다. 요청에 따라 커밋/푸시/배포 없음.

## 확인한 공급자 자료

- [Supabase sessions](https://supabase.com/docs/guides/auth/sessions): JWT session_id와 실제 auth.sessions 검사가 즉시 폐기 보장에 필요함을 재확인.
- [resetPasswordForEmail](https://supabase.com/docs/reference/javascript/auth-resetpasswordforemail): 고정 redirect를 통한 실제 암호 변경 동선.
- changelog.md 열기는 도구의 text/markdown 미지원으로 읽지 못했고, 설치된 auth-js 2.117.3 소스의 오류 코드 처리와 현재 문서를 확인했다.

## 독립 보안 검토 보완 1차

검토에서 발견한 다음 문제를 수정했다.

- PostgREST가 SQL 실행 전에 만료 JWT를 HTTP 401/PGRST301·303으로 거부하면 503으로 바뀌던 경로를 401로 보존했다. 실제 생성한 API 앱의 전역 세션 검사와 실제 ApiClient를 연결한 mock 통합 테스트에서 로그인→보호 요청 401→refresh 1회→보호 요청 재시도 200을 확인했다. 일시 장애는 503, 타인 세션 권한은 403을 유지한다.
- 비밀번호 PUT 성공 후 세션 정리 실패를 전체 실패로 보이던 경로를 `{password_changed:true,session_cleanup_pending:true}`로 분리했다. 화면은 변경 완료와 기기 로그아웃 미확인을 함께 안내한다. 세션을 이미 폐기한 JWT로 cleanup 재시도를 허용하는 우회는 추가하지 않았다.
- 같은/약한 비밀번호 등 공급자 400/422 검증 오류는 422로 구분하고 새 비밀번호 보안 조건을 확인하도록 안내한다. 실제 401/403만 링크 만료로 표시한다. PUT 요청/응답 유실과 5xx는 변경 결과 불확실 상태로 안내하고 ‘변경하지 못했다’고 단정하지 않는다. 원시 공급자 PUT에 10초 timeout 및 redirect:error를 적용했다.

보완 후 새 검증: 동일 API 6파일 **41 tests passed**. React 명령에 `src/api/clientAccountRefresh.test.ts`를 추가한 6파일 **38 tests passed**. API build 및 React app tsc 재확인. 최초 통합 테스트 파일은 API 쪽에서 desktop 소스를 가져오는 rootDir 경계를 피하려고 React 테스트 폴더에 배치했다. 실제 네트워크·메일·계정 변경은 없다.

## 독립 보안 검토 보완 2차

- 로그아웃 요청의 401은 폐기 확인일 수도, access JWT만 만료되고 refresh 가능 세션이 남은 상태일 수도 있다. ApiClient는 401도 서버 해제 미확인 오류로 반환한다. 기존 generation/토큰 쓰기 직렬화에 따른 로컬 제거는 그대로 수행하고 useSessionFlow는 로그인 화면에서 ‘이 기기에서 로그아웃했습니다. 서버 세션 해제는 확인하지 못했습니다’ 안내를 표시한다. 만료 JWT를 실제 서버 로그아웃 성공으로 묵인하지 않는다.
- 비밀번호 변경 후 cleanup의 401 역시 실제 세션 삭제를 확정하지 못하므로 모든 cleanup 오류는 `session_cleanup_pending:true`로 보수적으로 반환한다. 비밀번호 변경 완료 사실은 유지하며 실제 세션 존재 확인을 우회하지 않는다.
- 추가 검증: clientAccount의 401 회귀 테스트 및 `useSessionFlow.account.test.tsx`의 로그인 복귀·로컬 사용자 제거·미확인 안내 테스트. runtime adapter는 cleanup 401/PGRST303과 503 모두 pending임을 확인한다.
- 최신 명령: `pnpm --filter @business-assistant/api test src/supabase/runtime-auth.account.test.ts src/routes/recovery-page.test.ts` → **2 files / 12 passed**. `pnpm --filter @business-assistant/desktop-react test src/api/clientAccount.test.ts src/api/clientAccountRefresh.test.ts src/api/client.test.ts src/app/useSessionFlow.account.test.tsx` → **4 files / 29 passed**. API build 및 React app tsc → passed. 원격 변경/실메일/실계정 변경/커밋 없음.

## 독립 보안 검토 보완 3차: SMTP 장애 시 계정 열거

GoTrue는 미존재/확인 완료 주소에 실제 발송을 생략할 수 있다. 따라서 동일 SMTP 장애에서 기존 주소만 공급자 5xx→API 503이고 미존재 주소는 200이면 계정 열거가 가능하다. runtime adapter의 공급자 발송 오류를 내부 `email_provider_failure`로 분류하고 익명 route는 해당 오류와 공급자 정상 응답 모두 동일한 200 `{message: 조건부 안내,delivery_confirmed:false}`로 반환한다. 이는 메일 전달 확인/성공 응답이 아니라 요청 접수와 전달 미확인 상태다. 이메일·공급자 원문·비밀을 남기지 않는 구조화 경고 `event: account_email_delivery_unconfirmed`를 운영 로그에 기록해 실제 장애를 관찰한다. 고정 URL/기능 미설정은 계정과 무관하므로 503을 유지한다.

실제 runtime adapter를 통한 회귀 테스트에서 동일 SMTP 장애를 모사하고 기존 계정 공급자500/미존재 계정 공급자200에 대해 recovery/signup 두 유형의 API status/body가 동일하며 delivery_confirmed:false임을 확인했다. `pnpm --filter @business-assistant/api test src/routes/account.test.ts src/supabase/runtime-auth.account.test.ts` → **2 files / 14 passed**. `pnpm --filter @business-assistant/api build` → passed. 공급자 실발송이나 원격 호출 없음.

## 원격 SQL103 적용 및 세션 만료 경계 보완

- 최종 독립 검토에서 `memberships_select_member_or_manager`의 `user_id=auth.uid() OR role-helper`가 세션이 폐기된 JWT의 자기 멤버십 조회를 허용할 수 있음을 발견했다. 추가로 creator/self `OR`를 가진 tasks의 update/delete, 휴무 신청/이력 조회 정책도 전체 조건을 현재 세션 검사로 감쌌다. 기존 역할·creator·staff 연결 조건과 `private.has_organization_role(uuid,text[])`의 OID를 보존했다.
- `node scripts/db-tests/account-sessions-103.mjs` 재검증 PASS: 유효/만료/잘못된/타인 session, 기존 RLS OID 유지, 세션 페이지·비밀 필드 제외, 선택/전체 폐기와 refresh/MFA cascade, 폐기 동일 JWT의 업무·profile·org/member RPC·membership/task OR 거부, 감사 및 anon ACL, SQL 재적용.
- 사용자가 이미 승인한 SQL 적용 범위에 따라 SQL103을 Supabase `business-assistant`에 직접 적용했다(version `20261102055227`). 적용 후 auth.sessions 총 57행, customers19, appointments23, memberships1; migration은 업무 행과 실제 세션을 삭제/수정하지 않았다. membership/tasks/time-off 정책에 전체 session assertion, role-helper의 live-session 검사, anon 세션 RPC 거부, authenticated 허용을 원격 확인했다.
- 로그아웃 응답 401은 현재 세션이 실제 폐기됐다고 보장하지 않으므로 클라이언트는 이를 성공으로 처리하지 않고 서버 해제 미확인 안내를 표시한다. 비밀번호 변경 후 세션 정리 실패도 `session_cleanup_pending:true`로 보수적으로 표시한다. 추가 검증은 위 집중 API/React tests와 API build/React tsc.
- 독립 최종 재검토는 SMTP 장애 중 미존재 계정은 200, 실계정만 provider 5xx가 될 수 있어 API 503으로 구분되는 주소 열거 위험을 발견했다. provider 오류는 내부 코드로만 구분하고 route는 실제 전달 확인을 주장하지 않는 동일한 200 조건부 안내와 안전한 고정 경고 로그를 반환한다. 실제 route+runtime regression의 recovery/signup 흐름과 동일 SMTP 장애 시 주소별 status/body 일치를 확인했고 재검토에서 blocker가 없었다.
- 최종 집중 검증 (2026-11-02): API `pnpm --filter @business-assistant/api test src/routes/account.test.ts src/supabase/runtime-auth.account.test.ts` **2 files/14 passed**, React 계정·refresh 관련 **4 files/29 passed**, SQL103 격리 PASS, API build 및 React app typecheck PASS. 독립 최종 검토는 동일 SMTP 장애 주소 열거 재현 및 수정 경로 clean을 확인했다.
- 잔여: SMTP 설정/도메인 확인/실제 전달, 실계정 password 변경·session revoke, Native Keyring 및 앱 화면 인수는 하지 않았다. 초대/퇴사 흐름은 SET-003의 추가 범위다.


