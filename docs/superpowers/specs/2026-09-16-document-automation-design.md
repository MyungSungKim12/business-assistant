# 문서 자동화 모듈 설계

## 목적

조직별 문서 템플릿과 문서를 관리하는 공통 업무 기반을 제공한다. 1차 버전은 텍스트 문서 CRUD와 구독 기능 권한에 집중하고, 파일 업로드와 PDF·Word 생성은 후속 범위로 둔다.

## 범위

포함하는 기능:

- `document.template` 기능키 기반 메뉴·API 접근 제어
- 조직별 문서 템플릿 생성·조회·수정·보관
- 조직별 문서 생성·조회·수정·보관
- 문서 상태(`draft`, `final`, `archived`) 관리
- 제목, 본문, 템플릿 연결, 작성자, 생성일·수정일 반환
- Supabase RLS를 이용한 조직 테넌트 경계 보호

제외하는 기능:

- 파일 첨부와 Supabase Storage 연동
- PDF·Word 변환 및 인쇄
- 문서 공동 편집과 변경 이력
- 업종별 문서 양식

## 데이터 모델

### `document_templates`

- `id uuid primary key`
- `organization_id uuid not null references public.organizations(id)`
- `name text not null`
- `description text not null default ''`
- `content text not null default ''`
- `is_archived boolean not null default false`
- `created_by uuid not null references auth.users(id)`
- `created_at timestamptz not null default timezone('utc', now())`
- `updated_at timestamptz not null default timezone('utc', now())`

### `documents`

- `id uuid primary key`
- `organization_id uuid not null references public.organizations(id)`
- `template_id uuid null references public.document_templates(id)`
- `title text not null`
- `content text not null default ''`
- `status text not null default 'draft'` (`draft`, `final`, `archived`)
- `created_by uuid not null references auth.users(id)`
- `created_at timestamptz not null default timezone('utc', now())`
- `updated_at timestamptz not null default timezone('utc', now())`

두 테이블 모두 조직 ID·작성자·생성/수정 시각을 포함하고, 조직 ID와 작성자는 UPDATE 트리거로 불변 처리한다. 템플릿이 연결된 문서는 같은 조직의 템플릿만 참조할 수 있도록 데이터베이스 제약 또는 API 검증을 둔다.

## API

모든 엔드포인트는 Bearer JWT, 조직 멤버십, `document.template` 기능 권한을 순서대로 확인한다.

- `GET /api/v1/organizations/{organization_id}/document-templates`
- `POST /api/v1/organizations/{organization_id}/document-templates`
- `PATCH /api/v1/organizations/{organization_id}/document-templates/{template_id}`
- `GET /api/v1/organizations/{organization_id}/documents`
- `POST /api/v1/organizations/{organization_id}/documents`
- `PATCH /api/v1/organizations/{organization_id}/documents/{document_id}`

목록은 조직 ID로 필터링하고 최신 수정 순으로 반환한다. 생성·수정은 owner/admin 역할만 허용하며, 일반 멤버는 조회만 허용한다. 명시적 `null`, 빈 제목, 허용되지 않은 상태 값은 422로 거부한다.

## 권한과 RLS

- `document.template`가 없는 구독은 API에서 403을 반환한다.
- 조직 멤버십이 없는 사용자는 404 또는 403으로 조직 자료를 확인할 수 없다.
- 모든 테이블에 RLS를 활성화한다.
- SELECT는 조직 멤버십을 확인한다.
- INSERT/UPDATE는 조직 멤버십과 owner/admin 역할을 확인한다.
- DELETE 대신 보관 상태 또는 `is_archived`를 사용해 1차 범위에서 물리 삭제를 제공하지 않는다.

## 구현·검증 기준

- 기존 고객·작업 모듈의 인증, 기능 권한, 어댑터 패턴을 재사용한다.
- Supabase publishable key와 현재 사용자 JWT만 사용하고 service role key는 데스크톱에 노출하지 않는다.
- API 모델 검증, 저장소 payload 직렬화, RLS 마이그레이션 계약 테스트를 추가한다.
- 기존 전체 품질 검사와 신규 문서 모듈 테스트가 모두 통과해야 한다.

