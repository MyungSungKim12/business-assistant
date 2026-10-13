# Git 사용 안내

Git은 변경 이력을 남기고 팀원과 안전하게 공유하는 도구입니다. 비밀값이 들어갈 수 있는 `.env`는 이미 무시되지만, 커밋 전에는 항상 변경 내용을 직접 확인하세요.

## 브랜치 운영: main 하나

이 프로젝트는 **`main` 브랜치 하나만** 관리합니다. 기능별 브랜치를 만들지 않고, 작은 단위로 검증한 뒤 `main`에 바로 커밋하고 푸시합니다. 푸시하면 GitHub Actions가 타입 검사·테스트·빌드(CI)를 실행하므로, 푸시 후 Actions 탭에서 통과 여부를 확인합니다. 실패하면 다음 커밋으로 바로 고칩니다.

```powershell
git switch main
git pull --ff-only origin main
```

- 한 커밋은 한 가지 목적에 집중하고, 메시지는 `기능:`, `수정:`, `문서:`, `운영:`처럼 종류로 시작합니다.
- 푸시 전에 `scripts/check.ps1`(타입 검사·테스트·빌드)을 통과시킵니다.
- 위험한 변경(데이터베이스 마이그레이션 등)은 `migrations/README.md`의 적용 순서 안내를 먼저 읽고, 운영 DB에 적용한 뒤 앱을 갱신합니다.
- 협업자가 늘어 검토가 필요해지면 그때 보호 규칙(Pull Request)을 도입합니다.

## 일상 작업 순서

```powershell
git status
git diff
git add docs/05-development-guide.md
git diff --cached
git commit -m "문서: 개발 환경 안내 추가"
git pull --rebase origin main
git push origin main
```

`git status`는 바뀐 파일을, `git diff`는 아직 추가하지 않은 차이를, `git diff --cached`는 커밋에 들어갈 차이를 보여 줍니다. `git add .` 대신 필요한 파일을 지정해 의도하지 않은 파일이 들어가지 않게 합니다.

## 비밀정보 확인

커밋 전에는 `.env`가 추가되지 않았는지와 비밀값이 없는지를 확인합니다.

```powershell
git status --short
git diff --cached
git check-ignore .env
git grep -n -E "SUPABASE_SERVICE_KEY=.+|postgres(ql)?://[^[:space:]]+:[^[:space:]@]+@" -- .
```

실제 키, 토큰, 비밀번호, 데이터베이스 URL이 보이면 `git add`에서 제외하고 값을 교체합니다. 이미 커밋했다면 단순 삭제만으로 충분하지 않을 수 있으니 즉시 키를 폐기하고 저장소 관리자에게 알립니다.

## 원격 저장소(origin) 추가 또는 교체

원격 주소를 처음 추가할 때는 다음을 사용합니다.

```powershell
git remote add origin https://github.com/<계정>/<저장소>.git
git push -u origin main
```

이미 `origin`이 다른 주소를 가리키면 확인한 뒤 교체합니다.

```powershell
git remote -v
git remote set-url origin https://github.com/<계정>/<저장소>.git
git remote -v
```

주소를 교체하기 전에 대상 저장소와 권한을 꼭 확인하세요. 원격 주소에는 일반적으로 비밀번호나 토큰을 넣지 않습니다.
