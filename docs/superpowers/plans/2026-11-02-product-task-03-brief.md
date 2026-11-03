# N1030-03 / SET-003 계정 복구·세션 요구사항

상위 요구는 `docs/superpowers/specs/2026-10-30-product-completion.md` 3번이다. 2번이 구현·검토·SQL 적용된 뒤 착수한다. 기존 화면 스타일과 모든 기존 변경을 보존한다.

## 기존 접점과 확인된 공급자 계약

- API 인증: `apps/api/src/routes/auth.ts`의 `AuthGateway`, 실제 구현 `supabase/runtime-auth.ts`. `supabase/auth.ts`는 별도 축소 gateway이므로 실제 런타임을 놓치지 않는다. 공통 인증 제한은 `security/auth-guard.ts`.
- 실제 Supabase access JWT에는 `session_id` UUID가 있으며 `auth.sessions.id`와 연결된다. 로그아웃/세션 제거만으로 이미 발행된 JWT가 즉시 무효화되는 것은 아니므로 민감 요청은 실제 세션 존재를 확인해야 한다. 공식 [세션 문서](https://supabase.com/docs/guides/auth/sessions)를 다시 확인한다.
- 원격 `auth.sessions` 확인 컬럼: id,user_id,created_at,updated_at,not_after,refreshed_at,user_agent,ip 등. 클라이언트로 refresh_token_hmac_key/counter 등 인증 비밀을 반환하지 않는다. 실제 세션/개인 IP 값은 테스트 명목으로 조회하지 않는다.
- 2026-11-02 원격 스키마 사전 확인: `auth.refresh_tokens.session_id`와 `auth.mfa_amr_claims.session_id`는 `auth.sessions(id) ON DELETE CASCADE`다. 이는 스키마 확인일 뿐 실제 세션 삭제나 개인 인증 데이터 조회를 수행한 것은 아니다.
- PC `ApiClient`는 세션 generation·토큰 쓰기/삭제 직렬화가 이미 구현됐다. 이 경계를 깨지 않고 복구/서버 로그아웃을 연결한다.

## 기능 계약

1. 로그인 화면에 기존 스타일의 비밀번호 찾기/확인 메일 재전송 동선을 연결한다. 이메일·유형을 엄격히 검증하고 IP+이메일 제한을 적용한다. 계정 유무를 응답/문구로 노출하지 않는다. 실제 공급자 장애/미설정은 성공인 척하지 않는다.
2. 복구 redirect는 서버에서 설정한 고정 URL만 사용한다. 임의 클라이언트 redirect를 받지 않는다. 운영 HTTPS와 명시적 개발 loopback 예외를 구분하고 사용자정보/비밀이 URL query나 로그에 남지 않게 한다.
3. 메일 링크로 비밀번호를 바꾸는 실제 동선까지 만든다. 기존 PC 앱에 browser/deep-link 처리가 없으면 API가 제공하는 최소 고객용 복구 페이지를 사용할 수 있다. 링크 hash의 토큰은 메모리에서만 다루고 URL에서 즉시 제거하며 referrer/CSP를 제한한다. 새 비밀번호와 확인 입력·실패/만료·성공 후 재로그인을 안내한다. 원격 연결이 없으면 그 조건을 명시한다.
4. 환경 설정의 계정 영역에서 본인 현재/다른 세션의 생성/최근 갱신 시각과 기기 정보를 조회하고 선택 해제·전체 로그아웃을 수행한다. 기기 정보가 없으면 '알 수 없는 기기'로 표시하며 임의 이름/IP를 만들지 않는다. 실제 auth 세션과 임의 PC 설치 ID를 같은 것으로 표시하지 않는다.
5. DB 접근은 보안 함수로 제한하고 auth.uid()+현재 session_id 및 세션 소유자를 확인한다. 타인 session ID 조회/해제는 거절한다. 세션 제거는 Auth의 실제 refresh 가능성을 차단해야 하며, 앱 전용 목록에서 숨기기만 해서는 안 된다. managed Auth 테이블의 FK/권한을 검토하고 필요한 부분은 parent 원격 schema 사전 조회를 요청할 수 있다.
6. 이전 JWT의 잔여 유효기간 동안에도 업무 API가 계속 동작하지 않도록 실제 세션 검사와 취소를 연결한다. API global hook 또는 공통 조직 접근 검사에 적용하며 public login/refresh/recovery는 올바르게 예외 처리한다. 공개 DB 업무 RPC의 조직 권한 helper에도 폐기 세션이 허용되지 않는지 검토한다. 선택 해제·모든 기기 해제·다중 서버에서 캐시 때문에 복구되지 않도록 한다.
7. 설정/복구 입력과 네트워크 실패·연속 재시도·현재 세션 해제 후 local token 정리를 검증한다. 실제 메일은 테스트 중 전송하지 않는다.

## 테스트와 보고

- 익명 복구 요청의 계정 열거 방지, 제한/잘못된 redirect·이메일, 공급자 미설정/실패, 복구 token 유실·만료·새 비밀번호 검증.
- 본인 세션 조회·선택/전체 해제, 타인/비로그인·실제 세션 없는 JWT 거절, 동시 refresh/해제 경계.
- 집중 API/React/격리 PostgreSQL 및 타입만 실행한다. 전체 제품 테스트·실제 앱·실발송·공개 배포·원격 DB 쓰기·커밋/푸시 금지. SQL 적용은 parent가 한다.
- 새 SQL 번호는 부모가 확정한 직전 번호 다음을 사용한다(예상 103, 반드시 확인). 생성 함수/권한·환경변수/실제 동선·변경 파일·명령/결과·미완료 외부 조건을 `docs/product/audits/2026-11-02-account-recovery-sessions.md`에 기록하고 최종 메시지는 간단히 반환한다.
