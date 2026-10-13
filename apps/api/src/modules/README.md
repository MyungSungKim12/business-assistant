# API 모듈 규칙

Python 서버에서 옮긴 기능은 `modules/<이름>/`에 둔다.

- `gateway.ts`: `createRest`(../../supabase/rest.js)로 Supabase를 호출하는 게이트웨이와 그 타입
- `routes.ts`: `register<이름>Routes(app, organizations, gateway)`. 권한은 `organizations.requireAccess(token, organizationId, feature, write?)`
- `*.test.ts`: `app.inject`로 라우트를, 가짜 `fetcher`로 게이트웨이를 검증한다.
- 라우트 경로는 `/api/v1/organizations/:organizationId/...` 형식, 오류는 `ApiFailure`로 던진다.
- 등록(`app.ts`, `server.ts`)은 통합 단계에서 한 번에 한다. 모듈 작업자는 두 파일을 수정하지 않는다.
