# 작업·일정 모듈 보고서

- 조직별 tasks 테이블과 생성자/owner/admin 변경 RLS, `task.basic` 시드 권한을 추가했다.
- API는 인증, 멤버십, 기능 권한을 확인하고 PostgREST 어댑터는 현재 JWT와 publishable key만 사용한다.
- 전체 검사에서 94개 테스트, Ruff/mypy, Supabase import와 diff check가 통과했다.
