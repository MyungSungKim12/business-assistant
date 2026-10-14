# 작업·일정 모듈 보고서

- 조직별 tasks 테이블과 생성자/owner/admin 변경 RLS, `task.basic` 시드 권한을 추가했다.
- API는 인증, 멤버십, 기능 권한을 확인하고 PostgREST 어댑터는 현재 JWT와 publishable key만 사용한다.
- UPDATE trigger는 organization_id와 created_by 변경을 거부해 생성자 권한으로 다른 조직에 작업을 이동할 수 없게 한다.
- due_at은 timezone-aware datetime만 받고 description의 명시적 null은 422로 거부한다.
- PATCH의 description null과 naive due_at 회귀, BEFORE UPDATE 트리거 연결 계약을 추가했다.
- 전체 검사에서 97개 테스트, Ruff/mypy, Supabase import와 diff check가 통과했다.
