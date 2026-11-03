# N1030-06 / MED-002 사진 주기 정리·복구 안내

날짜: 2026-11-02~03. 담당: Codex task06 구현 및 독립 검토 에이전트. 상태: **verified (코드/SQL/실제 cron 1회 실행 한정)**. SQL106 원격 version `20261102071744` 적용 및 자동 실행 성공을 확인했다. 커밋·푸시·실사진 업로드·Storage 삭제·실앱 실행은 하지 않았다. 기존 작업 트리 변경을 보존했다.

## 구현 계약

- `migrations/106_customer_photo_maintenance.sql`: 기존 공개 `reconcile_customer_photo_uploads(uuid,uuid)`의 인자·integer 응답과 auth/조직 역할 검사를 유지한다. 공통 구현은 실행 권한이 회수된 private 함수다. JWT 없는 cron은 private 진입점만 사용하며 anon/authenticated/PUBLIC에는 전역 실행 경로를 주지 않는다.
- 1회 최대 250개, `FOR UPDATE SKIP LOCKED`, 전역 작업 advisory lock, 루프 10초 기한, cron SQL 명령의 statement timeout 15초/lock timeout 2초. timeout은 함수 SET에 의존하지 않고 cron이 실행할 SQL의 함수 호출 앞에서 설정한다. 실행 중단 시 배치 변경은 롤백하고 SQLSTATE만 진단에 기록한다.
- 배치 limit 전에 **130분 초과** 또는 **Storage 객체 크기·MIME 일치** 조건을 적용한다. 전송 중인 fresh pending 250개가 뒤의 완료 가능한 항목을 영구적으로 막지 않는다. 정확히 130분인 missing 항목은 pending이다.
- 크기·MIME는 `storage.objects.metadata`의 `size`/`mimetype`를 읽는다. 숫자 메타데이터는 길이를 제한한 numeric 비교로 bigint overflow를 피한다. 실제 Storage 객체/바이트를 SQL로 변경하지 않는다. 객체가 일치하면 ready, 만료 뒤 missing/mismatch이면 기존 보관 규칙으로 failed 처리하고 `upload_failure_reason`/`upload_failed_at`을 남긴다. 기존 ready와 사용자 보관 사진은 대상에서 제외한다.
- 전송 실패 이유는 `object_missing`, `metadata_mismatch`, `upload_not_completed`다. 이전 SQL100에서 이미 실패한 기록의 원인/시각은 만들어 채우지 않고 미기록으로 표시한다.
- 5분 주기 `customer-photo-upload-maintenance`, 매시간 17분 `phone-retention-maintenance`를 이름 기반 `cron.schedule`로 등록한다. 같은 migration 소유자로 재실행하면 동일 이름의 스케줄을 갱신한다. 전화 정리는 SQL104의 만료 인박스 최대500건, SQL105의 조직당 최근100000개 변경 보존 기준만 사용한다(최대10조직, 조직별 기존5000개 삭제 상한). 고객·활동·시술·거래·법적 보유 기록과 Storage는 삭제하지 않는다.
- 진단은 private 단일 행의 최근 시도·종료·성공/실패·처리 수·SQLSTATE다. 원문 오류, 고객명/전화/사진 경로/URL/토큰을 기록하지 않는다. 관리자 공개 응답에는 처리 수도 제외한다.

## API·화면 연결

- 관리자 전용 `GET /api/v1/organizations/:organizationId/customers/:customerId/photos/upload-status` → `customer_photo_upload_status(uuid,uuid)`. API에서 `crm.basic` 쓰기 권한, SQL에서 owner/admin과 JWT/조직을 검사한다. 게이트웨이는 응답 스키마와 각 항목의 조직/고객을 재검사한다. 기존 사진 목록/완료/휴지통 계약은 유지한다.
- 응답: pending/failed 항목의 ID·조직·고객·원본 표시명·상태·등록/실패 시각·원인, limit250, has_more, 최근 유지보수 상태. Storage 경로나 서명 URL은 반환하지 않는다. 실패 항목 우선250개를 보여 주고 더 있는 경우 제한을 명시한다.
- `PhotoUploadRecovery`는 상태 조회 실패를 별도 오류·재시도로 표시해 정상 갤러리를 유지한다. 상태 새로고침은 기존 갤러리 재조회/정리를 먼저 실행하므로 cron으로 복구된 사진이 화면에도 나타난다. 늦게 도착한 다른 고객의 상태는 무시한다. 읽기 전용에는 관리자 진단을 요청하지 않는다.
- `사진 다시 선택`은 현재 기기의 파일 선택기를 다시 연다. 이전 서명 URL이나 없어진 로컬 파일을 자동 재전송하지 않는다. 새 준비 요청이 실패하거나 선택을 취소해도 기존 pending/failed 메타데이터는 유지한다. 불확실한 PUT 응답/완료 응답은 기존 pending 복구 흐름을 유지한다.
- 공통 갤러리의 파일 선택/전송 busy를 `DraftBoundary`에 연결해 메뉴/로그아웃/종료 보호에 반영했다. 고객관리/시술관리 모두 로컬 고객 전환과 외부 focus 변경이 작업 종료까지 대기한다. 고객관리의 대기 중 외부 focus는 사진/프로필 저장 종료 뒤 최신 dirty 상태로 이동 확인을 다시 수행하며, 취소하면 기존 초안을 유지한다. 목록 내 고객과 fallback 추가 조회가 같은 경로를 사용한다. 추가 조회 중 새로 작성한 내용도 확인 대상이며 이전 조직/고객의 늦은 응답은 적용하지 않는다.

## 변경 파일

- SQL/계약: `migrations/106_customer_photo_maintenance.sql`, `scripts/db-tests/customer-photo-maintenance-106.mjs`, `scripts/db-tests/package.json`.
- 서버: `apps/api/src/routes/customer-photos.ts`, `apps/api/src/supabase/customer-photos.ts`, `apps/api/src/routes/customer-photos.test.ts`, `apps/api/src/supabase/customer-photo-status.test.ts`.
- 클라이언트: `apps/desktop-react/src/api/client.ts`, `schemas.ts`, `features/customers/photos/PhotoUploadRecovery.tsx`, `PhotoGallery.tsx`, `PhotoPanel.tsx`, `photoGallery.css`, `PhotoPanel.test.tsx`; `features/customers/CustomerPage.tsx`/`.test.tsx`, `features/treatments/TreatmentPhotos.tsx`, `TreatmentPage.tsx`/`.test.tsx`의 사진 busy 보호 연결.
- 제품 기록: 이 audit 및 `docs/product/modules/media.md`의 MED-002 상세만 갱신했다. broad README/changelog/ledger는 parent 작업이다.

## 검증 결과

| 명령/검증 | 결과 |
| --- | --- |
| API `pnpm --filter @business-assistant/api exec vitest run src/routes/customer-photos.test.ts src/supabase/customer-photo-status.test.ts` | 2파일 **8 passed**. 관리자 허용, 익명/다른 조직/역할 거부, JWT/인자 전달, 잘못된 응답·조직/고객 혼입 거부, 장애 매핑 |
| React `pnpm --filter @business-assistant/desktop-react exec vitest run src/features/customers/photos src/features/customers/CustomerPage.test.tsx src/features/treatments/TreatmentPage.test.tsx src/app/DraftBoundary.test.tsx src/api/client.test.ts` | 10파일 **128 passed**. 갤러리/휴지통 회귀, pending/failed·재선택 실패/재시도/취소, 갤러리 refresh, 늦은 타 고객 응답, 읽기 전용, 두 화면의 고객전환/입력 보호 및 외부 focus 취소/승인·추가 조회 중 작성한 초안 보호 |
| `node scripts/db-tests/customer-photo-upload-100.mjs` | PASS. SQL100 이전 완료/회복/130분/역할·조직 회귀 |
| `node scripts/db-tests/customer-photo-maintenance-106.mjs` | PASS. 실제 격리 PostgreSQL(PGlite) 상태/객체 메타데이터,250개 제한/fresh starvation/130분 정확 경계/잘못된 큰 숫자/반복 실행/ACL/익명/조직/진단 privacy/Storage 보존 |
| `$env:PHONE_DIRECTORY_PG_TOOLS=Join-Path $env:TEMP 'business-assistant-phone-directory-105-tools'; node scripts/db-tests/customer-photo-maintenance-106.mjs --postgres` | PASS. 로컬 임시 PostgreSQL18의 독립 연결에서 실제 row lock vs cron SKIP LOCKED, 수동 완료 경쟁, advisory duplicate busy,100ms timeout의 failed SQLSTATE57014·롤백·다음 실행 복구 |
| `pnpm --filter @business-assistant/api build` | TypeScript PASS |
| `pnpm --filter @business-assistant/desktop-react build` | TypeScript/Vite PASS. 기존 500KB 이상 chunk 경고 유지 |
| 독립 검토 | 첫 검토의 P2 갤러리 refresh/입력 보호/시술관리 전달 누락을 실패 테스트로 재현·수정(검토자 React3파일73 passed). 이후 parent 검토에서 외부 focus의 dirty 확인 누락을 발견해 아래 추가 검증으로 수정. 최종 좁은 재검토 actionable finding 없음, 검토자 CustomerPage12 passed |

화면 증거는 React DOM 인수 테스트다. 원격 SQL106 적용 뒤 `customer-photo-upload-maintenance`가 5분 주기로 활성 상태이며 `cron.job_run_details`에서 2026-11-02 23:55 UTC 실행의 `succeeded` 결과를 확인했다. 현재 사진 23건(활성 ready 13, 보관 ready 10), Storage 객체 23개, 내부 유지보수 진단 1행이며 pending/failed 기록은 없다. migration은 Storage 객체를 삭제하거나 수정하지 않았고, 실제 앱/Windows 화면/신규 실사진 업로드·다운로드는 검증하지 않았다. 전체 테스트는 요청대로 실행하지 않았다.

### 원격 적용과 실행 확인 — SQL106

- 사전 원격 확인에서 pg_cron 1.6.4 설치 전이었고 business-files 객체 23개였다. SQL106은 cron extension을 설치하고 사진 복구 5분/전화 보유기록 정리 매시 17분 스케줄을 이름 기반으로 등록한다.
- Supabase migration history: `20261102071744 / 106_customer_photo_maintenance`.
- 사후 확인: 사진 복구 cron active=true, 최근 실행 succeeded. `private.photo_upload_maintenance_status`는 내부 전용 RLS 테이블이고 anon/authenticated 직접 SELECT와 private 실행 함수 직접 호출은 거부된다. 공개 상태 조회는 authenticated 전용이다.
- 배치 작업 대상이 없어서 자동 실행은 성공했지만 실제 pending/failed 사진을 복구하거나 재선택하는 실데이터 인수는 이루어지지 않았다. 오래된 전화 이력의 hourly 정리 실행도 별도 인수로 남는다.

### parent 독립 검토 후 추가 수정

외부 focus가 사진 picker/전송 동안 대기한 뒤 `setSelected`/`setDirty(false)`를 직접 실행해 작성 중 프로필을 잃을 수 있던 누락을 확인했다. 목록 내 고객과 fallback 고객 각각에서 dirty 초안+사진 picker→외부 focus→picker 종료 시 확인 창이 없는 실패를 먼저 재현했다. 두 진입점은 최신 draft/busy 참조를 검사하는 공통 적용 함수로 연결했고 이동 취소 시 focus 요청만 해제한다. 추가 조회 중 새로 작성한 초안과 오래된 응답에도 같은 보호를 적용한다. `CustomerPage`12개, 상기 집중 React128개, TypeScript/Vite build 재검증 통과. SQL/API 변경과 원격 적용은 없었다.

## 공식 문서·원격 읽기 전용 사전 점검

- [Supabase cron 설치](https://supabase.com/docs/guides/cron/install), [cron.schedule 이름·주기·DB 함수·실행 이력](https://supabase.com/docs/guides/cron/quickstart), [Storage 스키마는 읽기 전용 메타데이터](https://supabase.com/docs/guides/storage/schema/design), [pg_cron 공식 extension SQL](https://github.com/citusdata/pg_cron/blob/main/pg_cron.sql)을 확인했다. changelog index도 읽었으며 이 설계와 관련된 cron/Storage 계약 변경은 찾지 못했다.
- 프로젝트 `rtmcrptkzcauzrwcfbph`는 PostgreSQL17.6.1.166. 읽기 전용 `pg_available_extensions` 결과 pg_cron1.6.4 사용 가능, installed_version=null, `pg_extension` 없음. `business-files` 객체23개 모두 size/mimetype 키가 있었다. 실제 이름/URL/전화/사진 내용은 읽지 않았다.
- PGlite와 로컬 임시 PostgreSQL은 pg_cron extension을 제공하지 않는다. 따라서 extension 생성 한 줄만 제거하고 **나머지 원본 migration**을 실행했으며 cron 이름/스케줄 저장·중복 upsert·명령 실행을 격리 stub으로 검증했다. 이는 실제 extension 등록/daemon 실행 검증이 아니다.

## 적용 전/후 운영 인수와 남은 범위

1. parent가 SQL106을 검토한 뒤 migration 소유자 postgres로 적용한다(100/104/105 선행). 필요하면 Supabase Dashboard에서 pg_cron을 활성화한 뒤 같은 SQL을 적용해도 `if not exists`로 호환한다. 원격 변경은 이번 에이전트가 수행하지 않았다.
2. 적용 후 `cron.job`에서 두 이름의 단일 활성 job·schedule·username·database·command를 확인한다. private 함수/진단 테이블의 PUBLIC/anon/authenticated 직접 실행·읽기 권한이 없고 공개 두 RPC는 JWT/조직/역할 검사를 유지하는지 확인한다.
3. 최소5분 이후 `cron.job_run_details`와 `private.photo_upload_maintenance_status`의 실행·종료·SQLSTATE를 확인한다. 설치만 성공하고 daemon이 실행되지 않는 경우에는 운영 완료로 표시하지 않는다. 사진/Storage 및 고객19/예약23 등 기존 실데이터 건수의 유지도 parent가 확인한다.
4. 실제 기기 새 사진의 PUT 완료·응답 유실·만료와 화면 복구는 별도 운영 인수다. 스토리지 객체 메타데이터 일치를 검사하며 실제 바이트 해시/이미지 decode 검사는 포함하지 않는다.
5. 상태 목록은 실패 우선250개로 제한하며 전체 이력 페이지 탐색은 미구현이다. 백로그가250개보다 크면 여러 cron 실행이 필요하다. 진단은 마지막 실행1건이며 cron 자체 연결 실패/함수에 도달하기 전 오류는 `cron.job_run_details`로 확인한다. 강제 프로세스 종료까지 막거나 로컬 선택 파일을 디스크에 영속화하지 않는다.
6. 원본/썸네일 분리, 바이트 단위 진행률, Storage 객체 물리 삭제/고아 객체 수명주기는 여전히 별도 범위다. MED-002 전체를 verified로 올리지 않는다.
