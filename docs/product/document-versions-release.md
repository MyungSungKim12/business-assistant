# 동의서·서식 버전 관리 적용 안내

2026-09-22 · DOC-001 · 코드 구현 완료 / Python·화면·실환경 검증 대기.

## 사용 흐름

문서 자동화 → 동의서·서식 관리 → 새 서식 → 이름·설명·본문 → 초안 저장 → 게시.
게시본은 읽기 전용이며 이전 게시본 선택으로 내용을 조회한다. 수정은 새 버전 만들기 후 초안 저장/게시한다.
폐기는 신규 사용을 중지하고 이전 게시본을 남긴다. 폐기 후 복원/재편집은 제공하지 않는다.
새 버전 초안 작성 중에는 현재 템플릿이 초안이므로 일반 문서 작성의 템플릿 선택에서 제외된다.
서식의 법적 적정성 검토, 전자서명, 고객별 발행·교부·철회는 이번 기능이 아니다.

## 데이터와 호환성

- migration 018은 기존 007 문서 테이블과 조직 역할 함수가 필요하다. 기존 서식은 초안, 보관 서식은 폐기로 이관한다. 과거 게시자·게시 시각을 만들어내지 않는다.
- version은 서식 버전, revision은 모든 저장/상태 변경의 충돌 검사용 값이다.
- 게시 내용은 document_template_versions에 이름/설명/본문/게시자/DB 시각으로 별도 보존한다. 일반 사용자에게 SELECT만 허용한다.
- 현재 서식의 직접 쓰기를 회수하고 조직·관리자 검사, 행 잠금, 원자적 게시, 작업 ID 재시도를 RPC로 처리한다. 동일 ID의 다른 요청은 충돌한다.
- 기존 POST/PATCH document-templates 쓰기는 409로 새 mutations 경로 사용을 안내한다. 구버전 클라이언트 쓰기와 호환되지 않으므로 DB·서버·데스크톱을 함께 적용해야 한다.
- 고객/시술 자동 채움(DOC-002), 발행본과 특정 서식 버전 연결(DOC-003), 서명(DOC-004)은 아직 미구현이다. 기존 범용 documents API의 문서 status=final을 법적 서명 완료로 해석하지 않는다. 기존 문서 내용을 서식 변경으로 덮어쓰지는 않는다.

## 다른 PC에서 적용·검증

실제 DB에는 아직 적용하지 않았다. 대상 환경과 백업 확인 후 기존 클라이언트 쓰기를 중지하고 migration 018을 적용한다. 현재 상담 기능도 함께 사용할 경우 016→017 선행 적용이 필요하다. 서버·데스크톱을 같은 코드로 재시작한다.

```powershell
uv run --package business-assistant-server pytest apps/server/tests packages/common/tests -q --tb=short
uv run --package business-assistant-desktop pytest apps/desktop/tests -q --tb=short
uv run --package business-assistant-desktop mypy apps/desktop/src apps/server/src packages/common/src
npm test --prefix scripts/db-tests
uv run ruff check .
uv run ruff format --check .
```

화면 검증: 새 서식 저장, 게시 확인/취소, 게시본 읽기 전용, 새 버전 편집 후 이전 내용 보존, 폐기, 빈 본문 게시 거절, 통신 실패/동일 요청 재시도, 버전 충돌, 입력 중 다른 서식 선택/닫기/앱 종료 취소. 회원은 조회만, 타 조직은 데이터 미노출. 두 클라이언트의 동시 수정과 실제 PostgREST 권한/오류 매핑도 확인한다.

확인 전에는 DOC-001을 verified로 올리지 않는다. 수정 후 테스트를 통과한 범위와 화면 캡처 경로를 기능 문서에 추가한다. 이력을 지우는 다운 마이그레이션 대신 데이터 보존 상태에서 수정한다.

## 현재 증거

- `npm test --prefix scripts/db-tests`: 시술 15 + 상담 12 + 서식 버전 10 = 37개 격리 PostgreSQL 검증 묶음 통과.
- 서식 DB 테스트는 기존 007과 실제 018 파일을 읽으며, 인증·조직 fixture 및 최소 권한을 구성한다. 실패→구현→통과 확인. 전체 migration 체인·JWT·다중 연결 경합·Supabase Advisor 검증은 아니다.
- Python API/Qt 테스트는 작성했으나 회사 PC 실행 정책 때문에 미실행. 신규 화면 증거 없음. 기존 9월 18일 Python/화면 결과는 이번 변경의 증거가 아니다.
- `.venv/Scripts/ruff.exe check .`와 `format --check .` 통과. 별도 정적 검토에서 발견한 X/Alt+F4 닫기의 부모 목록 갱신 누락을 수정했다. 게시 트랜잭션 중 작업 기록 저장을 강제로 실패시켜 게시본·현재 상태가 함께 롤백되는 DB 사례도 통과했다.
- 공식 참고: [Supabase 함수와 권한](https://supabase.com/docs/guides/database/functions). 변경 이력 Markdown 조회는 도구의 콘텐츠 형식 오류로 읽지 못했으며 기존 프로젝트 RPC 패턴을 확장했다.
