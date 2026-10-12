# 테스트·문서·배포

## 코드 검증

저장소 기본 검증은 다음 스크립트를 사용합니다.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\check.ps1
```

Qt 데스크톱 테스트와 서버·공통 테스트는 환경 문제를 분리하기 위해 별도 프로세스로 실행할 수 있습니다. DB 변경은 `scripts/db-tests`의 격리 시나리오와 다른 조직 접근 거절을 함께 확인합니다.

## 문서 로컬 실행

문서 도구를 별도 가상환경에 설치하는 것을 권장합니다.

```powershell
py -m venv .venv-docs
.\.venv-docs\Scripts\python.exe -m pip install -r requirements-docs.txt
.\.venv-docs\Scripts\python.exe -m mkdocs serve
```

브라우저에서 `http://127.0.0.1:8000`을 엽니다. 앱 서버가 이미 8000번 포트를 사용한다면 문서 포트를 바꿉니다.

```powershell
.\.venv-docs\Scripts\python.exe -m mkdocs serve -a 127.0.0.1:8001
```

## 문서 검증

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\docs\validate-guide.ps1
.\.venv-docs\Scripts\python.exe -m mkdocs build --strict
```

첫 명령은 필수 페이지, 로컬 링크, 배포 설정과 비밀값 패턴을 확인합니다. 두 번째 명령은 사이트 전체를 실제로 생성하며 경고도 실패로 처리합니다.

## GitHub Pages 배포

`.github/workflows/docs-pages.yml`은 다음 방식으로 동작합니다.

- pull request: 의존성을 설치하고 엄격 빌드까지만 수행
- `main` push: 빌드 결과를 GitHub Pages artifact로 올리고 배포
- 수동 실행: Actions 화면에서 필요할 때 실행

저장소의 **Settings → Pages → Source**가 **GitHub Actions**로 설정되어 있어야 합니다. 배포 주소는 `https://myungsungkim12.github.io/business-assistant/`입니다.

## 기능 변경 시 문서 갱신

1. `docs/product`의 기능 ID와 상태를 먼저 확인합니다.
2. 실제 버튼명이나 업무 흐름이 바뀌면 `docs/guide`를 수정합니다.
3. 대표 화면이 달라지면 `docs/screenshots` 캡처를 교체합니다.
4. 오류·취소·재시도·권한과 조직 경계를 검증합니다.
5. 제품 변경 이력과 실환경 검증 여부를 기록합니다.
