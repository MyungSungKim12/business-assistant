# 파일·자료 관리 모듈 설계서

- 작성일: 2026-09-17
- 상태: 구현 전 검토 대기
- 대상 기능 키: `files.basic`

## 1. 목표와 범위

조직 구성원이 업무 파일을 조직 단위로 보관하고, 권한이 있는 사용자에게만 업로드·다운로드·보관 처리를 제공한다. 파일 본문은 Supabase Storage의 비공개 버킷에 저장하고 PostgreSQL에는 메타데이터만 저장한다.

포함 범위:

- 조직별 파일 메타데이터 등록 및 목록 조회
- 서버가 발급하는 짧은 만료 signed upload/download URL
- 파일 보관(논리 삭제) 및 보관 파일 제외 조회
- 조직 경계와 역할(owner/admin/member)에 따른 접근 제어
- Storage·테이블 RLS, 마이그레이션, 단위 테스트, 운영 문서

파일 미리보기, 바이러스 검사, 대용량 재개 업로드, 외부 공유 링크, 업종별 자동 분류는 후속 범위로 둔다.

## 2. 데이터 모델

새 테이블 `public.file_assets`를 추가한다.

| 컬럼 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK, `gen_random_uuid()` |
| `organization_id` | `uuid` | `organizations.id` FK, 삭제 시 cascade |
| `uploaded_by` | `uuid` | `auth.users.id` FK, 삭제 제한 |
| `storage_path` | `text` | unique, 서버 생성 경로 |
| `original_name` | `text` | 1~255자 |
| `content_type` | `text` | 1~255자 |
| `size_bytes` | `bigint` | 0 이상, MVP 최대 50 MiB |
| `is_archived` | `boolean` | 기본 false |
| `created_at` / `updated_at` | `timestamptz` | UTC, 자동 갱신 |

`storage_path`는 클라이언트 값을 그대로 사용하지 않는다. 서버가 `<organization_id>/<file_id>-<안전한 파일명>` 형식으로 생성하고 경로 구분자·제어 문자를 제거한다. 조직 ID가 첫 세그먼트이므로 Storage RLS가 조직을 판정할 수 있다.

`(organization_id, is_archived, created_at desc)` 인덱스를 만든다. 테이블 RLS는 기존 조직 멤버십 헬퍼와 역할 정책을 재사용한다.

## 3. Storage 설계

- 비공개 버킷 이름: `business-files`
- public URL은 사용하지 않는다.
- 업로드 URL은 `upsert=false`로 발급해 UPDATE 권한을 불필요하게 만든다.
- Storage 객체 이름이 조직 ID로 시작하는지 검사한다.
- 같은 조직 멤버는 객체를 조회·다운로드할 수 있다.
- 보관은 owner·admin만 가능하다.
- MVP의 삭제 API는 `is_archived=true`로 전환하는 논리 삭제다. 실제 객체 삭제는 후속 백그라운드 정리 작업으로 분리한다.

Storage RLS에는 최소 `SELECT`, `INSERT` 정책을 둔다. desktop 앱에 service-role 키를 배포하지 않고, 서버도 인증된 사용자 컨텍스트와 조직 권한을 통과한 요청에서만 signed URL을 발급한다.

## 4. API 계약

모든 경로는 `/api/v1/organizations/{organization_id}` 하위이며 현재 사용자와 조직 멤버십을 검증한다.

### 파일 목록

`GET /files?include_archived=false`

- `items`, `next_cursor`(MVP에서는 null 가능)를 반환한다.
- 최신 `created_at` 내림차순으로 정렬한다.
- 응답에는 `id`, `original_name`, `content_type`, `size_bytes`, `uploaded_by`, `created_at`, `is_archived`를 포함하고 Storage path는 노출하지 않는다.

### 업로드 URL

`POST /files/upload-url`

요청은 `original_name`, `content_type`, `size_bytes`다. 서버는 entitlement·역할·입력·50 MiB 제한을 확인한 후 메타데이터를 생성하고 10분짜리 signed upload URL을 반환한다. 클라이언트는 URL로 업로드를 완료하고 반환된 파일 ID를 보관한다.

### 다운로드 URL

`POST /files/{file_id}/download-url`

보관되지 않은 파일이며 같은 조직의 멤버일 때만 5분짜리 signed download URL을 반환한다.

### 보관 처리

`DELETE /files/{file_id}`

owner·admin만 호출할 수 있으며 `is_archived=true`로 전환한다. 이미 보관된 파일은 멱등적으로 성공 처리한다. Storage 객체는 즉시 삭제하지 않는다.

권한 부족은 403, 다른 조직/없는 ID는 정보 노출을 막기 위해 404, 잘못된 입력은 422로 통일한다.

## 5. 서버 구조

- `ports/repositories.py`: 파일 메타데이터 타입과 `FileRepository` 계약 추가
- `ports/storage.py`: signed URL 계약을 기존 추상화에 추가하거나 충돌 시 `FileStoragePort`로 분리
- `adapters/supabase_files.py`: PostgREST와 Storage SDK 구현
- `api/files.py`: 인증·조직 멤버십·entitlement·역할 검증 및 HTTP 스키마
- `api/router.py`: files 라우터 등록
- 기존 Supabase URL/publishable key 환경변수를 재사용하고 버킷명만 설정 가능하게 한다.

## 6. 테스트와 검증

- migration의 테이블/RLS/인덱스/버킷 정책 계약 테스트
- 가짜 repository/storage를 이용한 정상 목록·업로드·다운로드·보관 및 401/403/404/422 테스트
- 경로 정규화와 50 MiB 경계값 테스트
- Supabase 네트워크에 의존하지 않는 테스트 유지
- `scripts/check.ps1`, `git diff --check` 통과 및 전체 테스트 수 문서 갱신

## 7. 구현 순서

1. 설계 승인 후 migration과 feature seed를 추가한다.
2. repository/storage 포트와 Supabase adapter를 구현한다.
3. API와 테스트를 entitlement 흐름에 연결한다.
4. README·메뉴 문서·Supabase 적용 안내를 갱신한다.
5. 전체 검증 후 한글 커밋 메시지로 main에 커밋하고 push한다.

## 8. 결정 사항

개인별 파일이 아닌 조직 공유 파일, 50 MiB 단일 업로드, 논리 삭제로 정했다. 이 방향으로 진행하려면 이 설계서를 승인해 주세요. 승인 후 구현을 시작한다.
