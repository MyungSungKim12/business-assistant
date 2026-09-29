# 시술 상태·정정 이력 구현 계획

**목표:** TRT-002에서 시술 준비/시작/완료/중단과 사유 있는 정정, 변경 전후 이력, 충돌 보호를 구현한다.
**설계:** 기존 기록은 legacy, 신규는 draft. draft→in_progress→completed, draft/in_progress→cancelled. 완료/중단/기존 기록의 정정은 사유 필수. 기존 기록은 일반 편집도 호환한다. 변경은 조직·고객·기록 범위의 단일 DB 트랜잭션에서 버전 검사와 감사 스냅샷을 남긴다.
**기술:** PySide6, FastAPI, PostgREST RPC, PostgreSQL. 제품 기준: docs/product/menus/04-consultations-treatments.md.

## 제약·결정

- 사용자 승인된 다음 단계 범위에서 로컬 코드·검증·문서 작성. 실서버 마이그레이션·실데이터 쓰기·커밋·배포는 하지 않는다.
- 별도 실제 사진/결제/재고 기능은 이번 단계에 포함하지 않는다.
- 기존 미커밋 작업과 같은 프로젝트에서 연속 구현한다. 작업 트리 이동/초기화 없음.
- 기존 SQL 번호 관례에 따라 016 migration. CLI 미설치이며 기존 파일들은 Supabase CLI 형식이 아니다.
- 구현 스킬의 분담에 따라 DB migration/격리 DB 검증을 별도 담당에 배정하고 API/UI를 현재 담당이 구현한다.

## 계약

- Treatment에 status, version, started_at, ended_at 추가. 누락 응답은 legacy/version1로 호환 표시.
- POST /organizations/{org}/customers/{customer}/treatments/{id}/mutations
  `{action, expected_version, operation_id, reason, values}`. action: edit/correct/start/complete/cancel.
- GET 같은 기록 경로 /events: actor_id, occurred_at, action, reason, before_data, after_data 목록.
- RPC mutate_treatment(p_organization_id,p_customer_id,p_treatment_id,p_expected_version,p_operation_id,p_action,p_reason,p_values).
- 이전 PATCH는 DB 변이 RPC edit로 연결한다. expected_version 없이 호출하는 구버전은 409로 새로고침/업데이트를 안내한다.
- 응답 유실 재시도는 같은 operation_id 사용. 변경 입력이면 새로운 ID. 버전충돌 409, 미존재404, 권한403, 장애503.

## 작업

- [x] DB: 행 잠금/권한 검사/불변 전후 스냅샷/operation_id 재실행·직접 쓰기 차단, 격리 SQL 검증.
- [x] 서버: DTO/저장소/RPC/이벤트 API와 입력·권한·오류 계약 테스트 먼저 작성 후 구현.
- [x] UI: 상태/버전 DTO, 상태 버튼과 사유, 이력 조회, readonly와 미저장 입력 보호, 재시도 키 유지.
- [x] 회귀: desktop 및 server/common 별도 테스트, Ruff/mypy, 실제 SQL 테스트, 화면 1280/1100 확인.
- [x] docs: TRT-002 검증된 범위만 표시, migration 적용 전 제한/배포 순서/증거 기록.

## 인수

동일 버전에서 하나의 변경만 성공한다. 완료 기록 일반 편집은 거부되고 정정은 이전 내용·사유·행위자·시각을 보존한다. 다른 조직/일반회원/직접 테이블 API가 쓰기 권한을 우회할 수 없다. DB 실패 시 상태와 감사 이력이 함께 롤백된다. 새 서버/앱/마이그레이션 적용 순서를 문서로 남긴다.


## 실행 결과

117 desktop / 143 server·common / 15 PostgreSQL 검증 통과. Ruff/format, mypy64 통과. DB 구현·별도 DB 검토와 API/UI 검토 완료. 비동기 이력 오류 경합/중단 사유 보존/0원 표시를 수정하고 회귀 테스트 추가. 작은 창 겹침을 스크롤 편집으로 보완. 실제 DB 적용 없음. 운영 제약은 docs/product/treatment-lifecycle-release.md에 기록.
