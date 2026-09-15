$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot

$standardUvDirectory = Join-Path $env:USERPROFILE ".local\bin"
$standardUvPath = Join-Path $standardUvDirectory "uv.exe"
$uvCommand = Get-Command uv -ErrorAction SilentlyContinue

if ($null -ne $uvCommand) {
    $uv = $uvCommand.Source
} elseif (Test-Path -LiteralPath $standardUvPath) {
    $env:Path = "$standardUvDirectory$([System.IO.Path]::PathSeparator)$env:Path"
    $uv = "uv"
} else {
    throw "uv를 찾을 수 없습니다. C:\\Users\\<사용자>\\.local\\bin\\uv.exe에 설치했는지 확인하거나 https://docs.astral.sh/uv/getting-started/installation/ 안내를 따르세요."
}

function Invoke-Uv {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    & $uv @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "uv 명령이 실패했습니다: uv $($Arguments -join ' ')"
    }
}

$trackedEnvironmentFile = & git ls-files -- .env
if ($LASTEXITCODE -ne 0) {
    throw "Git에서 .env 추적 여부를 확인할 수 없습니다."
}
if ($trackedEnvironmentFile) {
    throw ".env는 비밀값을 포함할 수 있으므로 Git에 추가하면 안 됩니다. Git 인덱스에서 제거하세요."
}

Invoke-Uv run ruff check .
Invoke-Uv run ruff format --check .
Invoke-Uv run python -m mypy apps/server/src apps/desktop/src packages/common/src
$env:QT_QPA_PLATFORM = "offscreen"
Invoke-Uv run python -m pytest
