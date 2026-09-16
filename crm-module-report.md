# CRM 고객·거래처 모듈 보고서

- `customers`는 `organization_id` 외래 키와 인덱스를 사용하며, RLS에서 모든 멤버의 조회와 owner/admin의 변경만 허용한다.
- FastAPI 고객 API는 매 요청에서 인증, 조직 멤버십, `crm.basic` entitlement를 확인한다. 생성·수정·삭제는 owner/admin 역할도 확인한다.
- Supabase 고객 어댑터는 publishable key와 현재 Bearer access token만 사용하며, 모든 조회·변경에 조직 ID 조건을 포함한다. 서비스 키는 사용하지 않는다.
- 잘못된 입력은 422, 조직/고객 범위 밖 레코드는 404, 저장소 또는 공급자 오류는 세부 정보를 노출하지 않는 503으로 변환한다.

## 검증 기록

- 테스트 우선 작성 후 API/어댑터 누락으로 실패하는 RED 상태를 확인했다.
- `powershell -ExecutionPolicy Bypass -File scripts/check.ps1`: Ruff format/lint, mypy 및 전체 테스트 91개 통과.
- `uv run python -c "import supabase; print('supabase import ok')"`: Supabase import 통과.
- `git diff --check`: 공백 오류 없음.
- PATCH의 명시적 `name` 또는 `notes` null은 422로 거부하고, 생략 필드는 기존 값으로 유지됨을 API·어댑터 회귀 테스트로 확인했다.
- 로그인 전환 테스트는 메인 창 생성 뒤 로그인 다이얼로그가 닫히는 Qt 이벤트까지 대기하도록 안정화했다. 전체 검사를 연속 두 차례 실행해 각각 91개 테스트 통과를 확인했다.
