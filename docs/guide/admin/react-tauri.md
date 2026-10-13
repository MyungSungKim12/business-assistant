# React/Tauri 데스크톱 미리보기

React/Tauri 전환은 PySide6 앱을 보존한 상태에서 진행 중입니다. 현재 전환된 범위는 로그인, 조직 선택, 고객 목록·프로필, 활동, 사진 등록과 실제 데이터 대시보드입니다.

1. 첫 PowerShell에서 `powershell -ExecutionPolicy Bypass -File .\scripts\run-server.ps1`로 서버를 시작합니다.
2. 둘째 PowerShell에서 `powershell -ExecutionPolicy Bypass -File .\scripts\run-react-web.ps1`로 웹 미리보기를 시작합니다.
3. Rust 도구 체인이 설치된 PC에서는 `powershell -ExecutionPolicy Bypass -File .\scripts\run-react-desktop.ps1`로 Native 창을 시작합니다.

Native 사진 업로드/조회에는 `.env`에 `BUSINESS_ASSISTANT_STORAGE_HOST`를 설정해야 합니다. 값은 `https://` 없이 Supabase Storage 호스트 이름만 넣습니다. 예: `BUSINESS_ASSISTANT_STORAGE_HOST=프로젝트참조.supabase.co`.

사진 등록은 Native 창에서 운영체제 파일 선택 창으로 JPEG, PNG, WebP 파일을 고릅니다. 10MB를 넘는 파일은 선택 후 업로드 전에 차단됩니다. 업로드 실패 안내에 사진 ID가 표시되면 해당 ID를 운영 담당자에게 전달해 보관 상태를 확인합니다.

예약, 시술, 매출과 ERP 메뉴는 React 전환 전이므로 기존 PySide6 앱에서 사용합니다.
