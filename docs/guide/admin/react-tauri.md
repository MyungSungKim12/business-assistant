# React/Tauri 데스크톱 운영

React/Tauri가 유일한 데스크톱 클라이언트입니다. API는 `apps/api`의 Node/Fastify 서버이며 PySide6와 Python 업무 서버는 제거됐습니다. 현재 화면 범위와 인수 잔여는 [메뉴 상태](../user-guide/menu-status.md)와 [기능 대응표](../../product/react-tauri-parity.md)를 확인하세요.

1. 저장소 루트에서 `run-app.cmd`를 실행해 Node API와 Native Tauri 창을 함께 시작합니다.
2. API를 별도로 관리하거나 로그를 확인할 때는 `scripts/run-server.ps1`을 사용합니다.
3. `scripts/run-react-web.ps1`은 UI 개발용 브라우저 미리보기입니다. 제품 앱 실행에는 `run-app.cmd`를 사용합니다.

Native 사진 업로드/조회에는 `.env`에 `BUSINESS_ASSISTANT_STORAGE_HOST`를 설정해야 합니다. 값은 `https://` 없이 Supabase Storage 호스트 이름만 넣습니다. 예: `BUSINESS_ASSISTANT_STORAGE_HOST=프로젝트참조.supabase.co`.

사진 등록은 Native 창에서 운영체제 파일 선택 창으로 JPEG, PNG, WebP 파일을 고릅니다. 10MB를 넘는 파일은 선택 후 업로드 전에 차단됩니다. 업로드 실패 안내에 사진 ID가 표시되면 해당 ID를 운영 담당자에게 전달해 보관 상태를 확인합니다.

예약·할 일과 주요 매장 운영 메뉴에 생성·수정·승인 흐름이 구현되어 있습니다. 각 기능의 범위와 실DB 인수 여부는 [기능 대응표](../../product/react-tauri-parity.md)에서 구분해 확인하세요. 코드 구현 상태는 실 Supabase 인수를 의미하지 않습니다.
