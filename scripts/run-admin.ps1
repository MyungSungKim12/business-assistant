$ErrorActionPreference = 'Stop'
# 관리자 API(플랫폼 관리자 구독 교체) 서버. 서비스 키(APP_SUPABASE_SERVICE_KEY)를 읽는 유일한 프로세스이며
# 일반 API(scripts\run-server.ps1)와 다른 포트(APP_ADMIN_PORT, 기본 8001)에서 127.0.0.1 로만 연다.
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot
$envFile = Join-Path $repositoryRoot '.env'
if (-not (Test-Path -LiteralPath $envFile)) { throw '.env is missing. Copy .env.example to .env and configure Supabase.' }
# 개발용 자동 로그인 값은 관리자 서버에도 싣지 않는다(SEC-05).
$skip = @('BUSINESS_ASSISTANT_DEV_AUTO_LOGIN', 'BUSINESS_ASSISTANT_DEV_EMAIL', 'BUSINESS_ASSISTANT_DEV_PASSWORD')
foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) { continue }
    $name, $value = $trimmed.Split('=', 2)
    if ($skip -contains $name.Trim()) { continue }
    $value = $value.Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) { $value = $value.Substring(1, $value.Length - 2) }
    Set-Item -LiteralPath "Env:$($name.Trim())" -Value $value
}
if (-not $env:APP_SUPABASE_SERVICE_KEY) { throw '.env에 APP_SUPABASE_SERVICE_KEY 가 없어 관리자 서버를 시작할 수 없습니다.' }
if (-not $env:APP_PLATFORM_ADMIN_USER_IDS) { Write-Warning 'APP_PLATFORM_ADMIN_USER_IDS 가 비어 있어 모든 관리자 요청이 거부됩니다.' }
$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$corepackCommand = Get-Command corepack.cmd -ErrorAction SilentlyContinue
if ($null -ne $pnpmCommand) {
    & $pnpmCommand.Source --filter '@business-assistant/api' admin:dev
} elseif ($null -ne $corepackCommand) {
    & $corepackCommand.Source pnpm --filter '@business-assistant/api' admin:dev
} else {
    throw 'Unable to run pnpm. Install Node.js 24 or newer, or run corepack enable once as Administrator.'
}
if ($LASTEXITCODE -ne 0) { throw 'Node admin server failed to start.' }
