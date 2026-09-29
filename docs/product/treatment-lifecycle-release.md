# 시술 상태·정정 이력 적용 안내

## 현재 상태

2026-09-18 시술 상태 기능은 로컬 검증했다. **현재 2026-09-22 코드는 상담 migration 017까지 필요하며 새 Python/Qt 검증은 대기다.** 실제 Supabase 프로젝트에는 적용하지 않았다. 서버·앱·DB를 함께 적용해야 한다. DB가 이전 스키마이면 새 조회가 실패하므로 서버만 먼저 바꾸지 않는다.

## 적용 파일과 순서

1. 적용 대상 조직/환경을 확인하고 DB 백업 및 기존 migration 적용 상태를 확인한다. 기존 시술 테이블이 있는 migration 014까지의 스키마가 필요하다. 015는 데모 시드이므로 운영 적용의 선행 조건이 아니다.
2. 기존 클라이언트 쓰기를 중지할 점검 시간에 [016_treatment_lifecycle.sql](../../migrations/016_treatment_lifecycle.sql)을 한 번 적용한다. 파일 자체는 begin/commit 트랜잭션이다. 기존 시술은 legacy로 표시하고 시각/과거 이력을 만들어내지 않는다.
3. 새 서버와 새 데스크톱을 함께 재시작한다. 구버전 PATCH는 expected_version 누락 시 409가 되며 직접 treatment_records UPDATE/DELETE는 차단된다.
4. 별도 검증 고객으로 등록→시작→완료→사유 있는 정정→변경 이력을 확인한다. 운영 고객 데이터로 스모크 테스트하지 않는다.
5. 읽기 회원과 다른 조직 계정으로 읽기/쓰기 경계를 확인하고, 두 클라이언트에서 같은 버전을 변경해 뒤의 요청이 409인지 확인한다. 토큰·시크릿은 캡처/문서/로그에 넣지 않는다.

실서버 적용은 이 작업에서 수행하지 않았다. 장애가 나면 우선 쓰기를 중지하고 오류를 확인한다. 감사 테이블/새 컬럼을 삭제하는 롤백은 이력을 잃으므로 제공하지 않는다. 스키마를 유지한 채 수정하는 방식으로 복구한다.

## 운영 규칙

- 준비→진행→완료, 준비/진행→중단. 중단 사유 필수. 상태 변경 시각과 기록자는 DB가 정한다.
- 완료/중단은 일반 편집 불가. 정정은 사유와 함께 내용만 바꾸고 상태는 유지한다. before_data/after_data에 원본/변경본을 저장한다.
- 기존 기록은 수행 상태 미확인이므로 시작/완료 처리를 소급하지 않는다. 기존 기록 편집/정정도 새 변경부터 감사 기록을 남긴다.
- 버전충돌 시 입력은 유지하고 저장을 중지한다. 변경 전후 내용을 별도로 보존한 뒤 새로고침에서 버리기를 선택하면 최신 서버 값으로 교체한다. 자동 병합은 없다.
- 상태·수정·정정의 응답 유실 재시도는 동일 작업 ID를 사용한다. 신규 생성 POST의 멱등성은 아직 후속 과제다.
- 감사 기록이 있는 고객/시술/행위자를 지우는 FK cascade는 거부된다. 고객 보관과 감사 데이터 삭제/보존 정책은 별도다.
- 예정 금액/다음 방문일은 이 기록의 필드이며 실제 결제·예약·재고를 변경하지 않는다.

## 검증과 제한

```powershell
uv run --package business-assistant-desktop pytest apps/desktop/tests -q --tb=short
uv run --package business-assistant-server pytest apps/server/tests packages/common/tests -q --tb=short
npm ci --prefix scripts/db-tests --ignore-scripts --no-audit --no-fund
npm test --prefix scripts/db-tests
uv run ruff check .
uv run ruff format --check .
uv run --package business-assistant-desktop mypy apps/desktop/src apps/server/src packages/common/src
```

결과: desktop 117, server/common 143, 격리 PostgreSQL 15개 검증 통과. Ruff/format/mypy(64개 소스) 통과. DB 검증은 실제 PostgreSQL을 실행하는 PGlite이며 auth/조직 fixture를 사용한다. 실제 Supabase JWT/PostgREST·전체 migration 체인·동시 다중 연결 경합·Security Advisor 실행은 별도 검증이 필요하다. 자세한 DB 재현은 [DB 테스트 안내](../../scripts/db-tests/README.md).

화면: [1280×800](../screenshots/treatment-lifecycle.png), [1100×720 정정 모드](../screenshots/treatment-lifecycle-1100.png). 실제 고객과 무관한 명시적 데모다.

참고한 공식 지침: [Supabase DB 함수](https://supabase.com/docs/guides/database/functions), [변경 이력](https://supabase.com/changelog). 새 감사 테이블은 RLS와 SELECT 권한을 명시하고, 권한 상승 함수는 private 스키마에서 사용자·조직·역할을 검사한다.
## 2026-09-22 추가 적용 주의

현재 코드는 상담 컬럼을 조회하므로 016만 적용해서는 부족하다. 016 이후 `017_treatment_consultation.sql`을 적용한 서버/데스크톱 조합이 필요하다. 시술 시작 전 상담 목표 입력과 최신 고객 주의정보 확인을 완료한다. 기존 진행/완료 기록에 상담 확인을 소급 생성하지 않는다.

앞의 desktop117/server143 및 기존 화면 결과는 **9월 18일 코드**의 증거다. 017 상담과 018 서식 변경 이후 Python/Qt 검증은 현재 PC 정책으로 실행하지 못했다. 최신 격리 DB 검증은 37개(15+12+10)이며 다른 PC에서 앞의 명령과 실제 화면 검증을 다시 수행해야 한다.
