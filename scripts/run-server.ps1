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

& $uv run --all-packages python -m business_assistant_server
if ($LASTEXITCODE -ne 0) {
    throw "서버 실행에 실패했습니다."
}
