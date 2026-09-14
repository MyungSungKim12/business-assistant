$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot

$standardUvDirectory = Join-Path $env:USERPROFILE ".local\bin"
$standardUvPath = Join-Path $standardUvDirectory "uv.exe"
$uvCommand = Get-Command uv -ErrorAction SilentlyContinue

if ($null -ne $uvCommand) {
    $uv = $uvCommand.Source
} elseif (Test-Path -LiteralPath $standardUvPath) {
    # 현재 PowerShell 프로세스에서만 uv를 이름으로 실행할 수 있게 합니다.
    $env:Path = "$standardUvDirectory$([System.IO.Path]::PathSeparator)$env:Path"
    $uv = "uv"
} else {
    throw "uv를 찾을 수 없습니다. https://docs.astral.sh/uv/getting-started/installation/ 안내에 따라 uv를 설치한 뒤 PowerShell을 다시 열고 이 스크립트를 실행하세요."
}

function Invoke-Uv {
    param([Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments)

    & $uv @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "uv 명령이 실패했습니다: uv $($Arguments -join ' ')"
    }
}

& $uv python find 3.13 *> $null
if ($LASTEXITCODE -ne 0) {
    Invoke-Uv python install 3.13
}
Invoke-Uv sync --all-packages
