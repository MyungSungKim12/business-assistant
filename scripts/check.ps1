$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot

$trackedEnvironmentFile = & git ls-files -- .env
if ($LASTEXITCODE -ne 0) {
    throw "Git에서 .env 추적 여부를 확인할 수 없습니다."
}
if ($trackedEnvironmentFile) {
    throw ".env는 비밀값을 포함할 수 있으므로 Git에 추가하면 안 됩니다. Git 인덱스에서 제거하세요."
}

$pnpmCommand = Get-Command pnpm -ErrorAction SilentlyContinue
$corepackCommand = Get-Command corepack -ErrorAction SilentlyContinue
$pnpmArgs = @()
if ($null -ne $pnpmCommand) {
    $pnpm = $pnpmCommand.Source
} elseif ($null -ne $corepackCommand) {
    $pnpm = $corepackCommand.Source
    $pnpmArgs = @("pnpm")
} else {
    throw "pnpm을 찾을 수 없습니다. Node.js 24 이상을 설치한 뒤 PowerShell을 다시 열고 이 스크립트를 실행하세요."
}

function Invoke-Pnpm {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)
    & $pnpm @pnpmArgs @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "pnpm 명령이 실패했습니다: pnpm $($Arguments -join ' ')"
    }
}

# 1) 타입 검사  2) vitest(API, React, 공통 UI)  3) React 프로덕션 빌드
Invoke-Pnpm --filter "@business-assistant/api" exec tsc -p tsconfig.json --noEmit
Invoke-Pnpm run react:test
Invoke-Pnpm run react:build
Invoke-Pnpm run api:build

# 4) Rust 테스트(Rust가 있을 때만)
$userCargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if (Test-Path -LiteralPath $userCargoBin) { $env:Path = "$userCargoBin;$env:Path" }
if ($null -ne (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Push-Location -LiteralPath (Join-Path $repositoryRoot "apps/desktop-react/src-tauri")
    try {
        & cargo test --lib
        if ($LASTEXITCODE -ne 0) { throw "Rust 테스트가 실패했습니다." }
    } finally { Pop-Location }
} else {
    Write-Warning "Rust가 없어 cargo test를 건너뜁니다."
}
