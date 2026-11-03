# 2026-10-30 SQL 100 원격 적용

사용자가 “SQL은 너가 직접 실행해”라고 명시 승인하여 연결된 Supabase 플러그인으로 적용했다. 대상은 기존 `business-assistant` 프로젝트 `rtmcrptkzcauzrwcfbph`다. 커밋/푸시나 앱 실행·재시작은 하지 않았다.

## 실행 결과

- 프로젝트가 `INACTIVE`였고 SQL 연결은 `Database is possibly not accessible at the moment`로 거절됐다. `restore_project`로 재개했으며 `COMING_UP`을 거쳐 `ACTIVE_HEALTHY` 확인 후 진행했다.
- 실제 스키마에서 `customer_photos` 기존 컬럼·보관 트리거와 099까지의 migration 이력을 확인했다. 적용 전 총 23행, 활성 13행이며 활성 13행 모두 Storage 경로·크기·MIME가 일치했다. 개인 이름·전화·메모·이미지 내용은 조회하지 않았다.
- 로컬 격리 PostgreSQL 검증을 다시 실행해 PASS를 확인하고 로컬 `migrations/100_customer_photo_upload_completion.sql` 전체를 그대로 `apply_migration`에 전달했다.
- **적용 성공**: name=`100_customer_photo_upload_completion`, version=`20261030071926` (2026-10-30 07:19:26 UTC / 16:19:26 KST).
- 적용 후 총 23행·활성 13행 유지, 활성 ready 13행, pending 0행, failed 0행 확인. 기존 Storage 객체는 삭제하지 않았다.

## 원격 검증

- `upload_state`: NOT NULL, 기본값 `pending`; `uploaded_at`: nullable.
- `customer_photos_upload_guard` 활성 트리거 1개, `idx_customer_photos_pending` 인덱스 확인.
- `complete_customer_photo_upload`, `reconcile_customer_photo_uploads`: 존재·고정 빈 search_path·authenticated 실행 가능·anon 실행 불가 확인.
- private trigger 함수 `guard_customer_photo_upload`: anon/authenticated 직접 실행 불가 확인.
- 실제 사용자 subject가 없는 DB 세션에서 두 공개 RPC를 호출해 `insufficient_privilege`로 거절되는 것을 확인했다. 고객/사진 데이터를 삽입·수정하는 테스트 호출은 하지 않았다.
- Security Advisor는 `authenticated_security_definer_function_executable` WARN 121건(종전 119개와 새 공개 RPC 2개) 및 기존 `auth_leaked_password_protection` WARN 1건을 반환했다. 새 RPC의 authenticated 노출은 의도한 API 계약이며 함수 내부 JWT·조직/역할 검사와 anon 거부를 유지한다. 이것을 실사용 JWT 권한 시험 완료로 해석하지 않는다. 관련 기준: [SECURITY DEFINER 실행 경고](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable), [유출 비밀번호 보호](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection).

## 남은 확인

SQL을 다시 수동 실행할 필요는 없다. 새 소스를 사용하는 API/PC를 재시작한 뒤 실제 사진 등록·조회 동선을 확인한다. Android 0.3.0 설치·실기기 자동 동기화 인수는 별도다. 이번 적용은 전체 기능 테스트나 실제 사진 파일 업로드 검증을 대신하지 않는다.
