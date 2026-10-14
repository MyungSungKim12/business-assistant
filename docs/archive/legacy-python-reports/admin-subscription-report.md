# 관리자 구독 API 보고서

- UTC 호환 timezone-aware `starts_at`과 `ends_at`만 비교하며, naive/aware 혼합은 422로 검증한다.
- RPC가 보고한 조직 미존재 domain error는 adapter/API에서 안정적인 404로 변환한다.
- 서비스 키는 서버 전용 RPC adapter에만 유지한다.

## 검증 기록

- naive `starts_at`와 timezone-aware `ends_at` 혼합 요청은 API 회귀 테스트에서 422와 `timezone-aware` 상세 메시지를 확인했다.
- repository가 `AdminSubscriptionNotFoundError`를 발생시키는 경우 API가 404로 변환됨을 회귀 테스트로 확인했다.
- `powershell -ExecutionPolicy Bypass -File scripts/check.ps1`: Ruff format/lint, mypy 및 전체 테스트 81개 통과.
- `uv run python -c "import supabase; print('supabase import ok')"`: Supabase import 통과.
- `git diff --check`: 공백 오류 없음.
