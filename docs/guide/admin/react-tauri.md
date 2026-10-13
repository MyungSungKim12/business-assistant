# React/Tauri 데스크톱 운영

React/Tauri가 데스크톱 클라이언트의 기준입니다. 현재 전환된 범위는 로그인, 조직 선택, 고객 목록·프로필, 활동, 사진 등록과 실제 데이터 대시보드입니다.

1. 첫 PowerShell에서 `powershell -ExecutionPolicy Bypass -File .\scripts\run-server.ps1`로 Node API를 시작합니다.
2. 둘째 PowerShell에서 `powershell -ExecutionPolicy Bypass -File .\scripts\run-react-desktop.ps1`로 Native 창을 시작합니다.
3. UI 개발 중 브라우저 확인이 필요할 때만 `powershell -ExecutionPolicy Bypass -File .\scripts\run-react-web.ps1`을 사용합니다.

Native 사진 업로드/조회에는 `.env`에 `BUSINESS_ASSISTANT_STORAGE_HOST`를 설정해야 합니다. 값은 `https://` 없이 Supabase Storage 호스트 이름만 넣습니다. 예: `BUSINESS_ASSISTANT_STORAGE_HOST=프로젝트참조.supabase.co`.

사진 등록은 Native 창에서 운영체제 파일 선택 창으로 JPEG, PNG, WebP 파일을 고릅니다. 10MB를 넘는 파일은 선택 후 업로드 전에 차단됩니다. 업로드 실패 안내에 사진 ID가 표시되면 해당 ID를 운영 담당자에게 전달해 보관 상태를 확인합니다.

예약·할 일은 React 쓰기 흐름이 연결되어 있습니다. 시술·매출·회원권·재고·직원·정산·문서·파일은 실제 데이터 조회를 제공하며, 각 업무의 생성·정정·승인 흐름은 기능 동등성 문서에 따라 계속 전환합니다.
