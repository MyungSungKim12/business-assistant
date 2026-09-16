# 문서 자동화 모듈 구현 보고서

## 구현 내용

- `document.template` 권한 기반 문서 API를 추가했다.
- 조직별 `document_templates`와 `documents` 테이블 및 인덱스를 추가했다.
- 템플릿과 문서의 목록·생성·수정 API를 추가했다.
- member는 조회, owner/admin은 생성·수정만 가능하도록 서버 권한과 RLS를 적용했다.
- 조직 ID와 작성자 변경을 UPDATE 트리거로 차단했다.
- 문서 제목·템플릿 이름·상태·본문 길이와 명시적 null을 API에서 검증한다.
- PostgREST 어댑터는 publishable key와 현재 사용자 JWT를 사용한다.

## API

- `GET/POST /api/v1/organizations/{organization_id}/document-templates`
- `PATCH /api/v1/organizations/{organization_id}/document-templates/{template_id}`
- `GET/POST /api/v1/organizations/{organization_id}/documents`
- `PATCH /api/v1/organizations/{organization_id}/documents/{document_id}`

## 검증

- 마이그레이션 계약, 저장소 어댑터, API 권한·입력 검증 회귀 테스트를 추가했다.
- 전체 품질 검사에서 108개 테스트, Ruff, mypy, Supabase import와 diff check가 통과했다.

## 후속 범위

- Supabase Storage 파일 첨부
- PDF·Word 생성 및 인쇄
- 문서 공동 편집과 변경 이력
- 업종별 문서 양식
