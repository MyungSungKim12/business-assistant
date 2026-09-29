# DOC-002/003 고객·시술 문서 미리 채움과 발행본

사용자가 다음 순차 항목 구현을 요청했다. DOC-001 코드 기반으로 DOC-002와 불변 발행본에 필요한 DOC-003을 함께 구현한다. 담당 Codex. 기존 미커밋 변경 보존, 실DB 적용/배포/커밋 없음.

## 확정 범위

시술관리의 저장된 시술 → 문서 발행/이력 → 게시 상태 템플릿 선택 → 서버 미리보기 → 필수값/누락 확인 → 검토 체크 → 발행. 회원은 읽기만, owner/admin 발행. API에서 crm.basic과 document.template 모두 검사. 발행은 고객의 서명·동의 완료를 의미하지 않는다(DOC-004 후속).

지원 치환자는 `{{customer.name}}`, `{{customer.phone}}`, `{{customer.birth_date}}`, `{{treatment.name}}`, `{{treatment.date}}`, `{{treatment.practitioner}}`, `{{treatment.amount}}`, `{{treatment.consultation_goal}}`이다. 사용된 치환자 값이 비어 있거나 알 수 없는 치환자가 있으면 missing_fields에 표시하고 발행하지 않는다. 금액 0은 유효, 금액 미등록은 누락. 입력 값에 들어 있는 중괄호는 재치환하지 않는다. 문서는 일반 텍스트다.

발행 전 미리보기 본문은 읽기 전용이다. 내용 수정은 서식 새 버전에서 수행한다. 발행/조회 UI에 '발행본 · 서명 미확인' 표시. 빈 템플릿/비게시/폐기/고객-시술-조직 불일치를 거절한다.

## DB/API 계약 (공동 구현 경계)

새 public.issued_treatment_documents 테이블: id UUID, organization_id/customer_id/treatment_id/template_id UUID, template_version int, title/content text, source_snapshot jsonb, issued_by UUID, issued_at timestamptz, operation_id UUID, request_fingerprint jsonb. 조직+operation_id 유일, 각 원천 삭제 restrict, 클라이언트 직접 쓰기 전부 차단, 조직 회원 SELECT RLS. 기존 범용 documents는 그대로 두며 연결/서명 이력을 위조하지 않는다.

`public.preview_treatment_document(p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_template_id uuid) returns jsonb`: 내부 private 보안 함수에서 동일 조직 회원/대상 검사, 현재 게시본으로 계산. 반환 정확한 공통 필드: template_id(string), template_version(int), title(str), content(str), source_snapshot(object), missing_fields(list[str]). source_snapshot은 고객/시술 식별자와 표시 필드·원천 변경 지표를 포함하며 DB 담당이 상세 구조 결정. API/UI는 불투명 dict로 전달한다.

`public.issue_treatment_document(p_organization_id uuid,p_customer_id uuid,p_treatment_id uuid,p_template_id uuid,p_operation_id uuid,p_expected_preview jsonb) returns setof public.issued_treatment_documents`: 관리자/조직 확인, 작업키 잠금/replay 우선, 원천 잠금과 최신 미리보기 재계산, expected_preview 완전 동일 및 missing_fields 없음 확인 후 원자적 발행. 이후 원천 수정/폐기에도 발행본은 불변. 동일 작업키/동일 payload는 기존 결과 반환, 다르면409. SQLSTATE P0001 conflict, P0002 notfound,42501 forbidden,22023 validation.

API 경로 prefix `/organizations/{organization_id}/customers/{customer_id}/treatments/{treatment_id}/documents`:
- POST `/preview`: {template_id:UUID}, 반환 미리보기 dict 모델.
- POST 빈 suffix: {template_id:UUID,operation_id:UUID,expected_preview:dict}, 반환 발행본 모델 (request_fingerprint/operation_id는 응답 제외).
- GET 빈 suffix: 해당 조직/고객/시술 발행본 목록, 최신순.

데스크톱 ApiClient methods(session은 organization_id 다음): preview_treatment_document(org,session,customer_id,treatment_id,template_id), issue_treatment_document(org,session,customer_id,treatment_id,payload), list_issued_treatment_documents(org,session,customer_id,treatment_id). 모두 dict 또는 list[dict] 반환. _BoundTreatmentClient에서 session 결합, list_document_templates도 연결.

## 실행·증거

- [x] DB019와 실제 SQL 격리 검증: 13개 묶음 통과. 기존 회귀 포함 총50개.
- [x] 서버 전용 API/저장소/권한/오류 테스트 작성: API 담당. Python 실행은 대기.
- [x] 미리보기·발행 이력 대화상자, 시술관리 연결, HTTP 클라이언트 및 테스트 작성: 주 담당.
- [x] 별도 정적 검토·Ruff·DB 회귀·MD 기록. 2026-09-23 코드 구현 완료.
- [ ] 다른 PC Python/Qt/실제 Supabase 검증. 현재 정책 차단을 우회하지 않는다.

발행 버튼 중복 방지, 결과 불명확 시 같은 작업 ID로 재시도, 선택·닫기·종료 중 보류 요청 보호. 미리보기 재조회는 검토 체크 해제. 이력 조회 실패를 빈 이력으로 오인시키지 않고 오류/재시도를 제공한다. PDF 출력, 실제 서명, 교부, 철회, 결제 전달은 이번 범위 밖이다.
