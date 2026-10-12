# Git 브랜치와 worktree

Git worktree를 사용하면 현재 작업 폴더를 건드리지 않고 같은 저장소의 다른 브랜치를 별도 폴더에서 열 수 있습니다.

## 새 기능 작업

저장소 루트의 PowerShell에서 실행합니다.

```powershell
git fetch origin
git worktree add .worktrees\customer-report -b codex/customer-report origin/main
cd .worktrees\customer-report
```

브랜치 이름은 기본적으로 `codex/` 접두어를 사용합니다. 기능 하나, 문서 하나처럼 검토 가능한 범위로 나눕니다.

## 기존 브랜치 열기

```powershell
git worktree add .worktrees\customer-report codex/customer-report
```

한 브랜치는 동시에 두 worktree에서 checkout할 수 없습니다.

## 작업 상태 확인

```powershell
git worktree list
git status --short
git diff --check
```

커밋하기 전에 내가 수정한 파일과 기존 미커밋 변경을 구분합니다. 다른 작업자의 변경을 되돌리거나 `git clean`, `git reset --hard`로 지우지 않습니다.

## 작업 폴더 정리

변경을 커밋하고 필요한 검토가 끝난 뒤 원래 저장소에서 실행합니다.

```powershell
git worktree remove .worktrees\customer-report
git worktree prune
```

미커밋 변경이 있는 worktree는 먼저 상태를 확인합니다. 강제 제거는 복구하기 어려우므로 사용하지 않습니다.

## 이 프로젝트의 커밋 원칙

- 한글 커밋 메시지로 변경 목적이 드러나게 씁니다.
- 기능 상태는 검증된 범위만 `verified`로 올립니다.
- SQL, 서버, 공통 계약과 데스크톱을 함께 적용해야 하는 변경을 분리 배포하지 않습니다.
- push, PR, 병합과 Pages 게시처럼 공유 저장소에 영향을 주는 작업은 배포 시점을 확인한 뒤 수행합니다.
