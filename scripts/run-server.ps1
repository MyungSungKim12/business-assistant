$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot
$envFile = Join-Path $repositoryRoot '.env'
if (-not (Test-Path -LiteralPath $envFile)) { throw '.env is missing. Copy .env.example to .env and configure Supabase.' }
# 일반 API 서버는 서비스 키·플랫폼 관리자 목록·개발용 자동 로그인 값을 쓰지 않으므로 프로세스 환경에 싣지 않는다(SEC-02/SEC-05).
# 관리자 기능은 scripts\run-admin.ps1 로 별도 실행한다.
$skip = @('APP_SUPABASE_SERVICE_KEY', 'APP_PLATFORM_ADMIN_USER_IDS', 'APP_DATABASE_URL', 'BUSINESS_ASSISTANT_DEV_AUTO_LOGIN', 'BUSINESS_ASSISTANT_DEV_EMAIL', 'BUSINESS_ASSISTANT_DEV_PASSWORD')
foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) { continue }
    $name, $value = $trimmed.Split('=', 2)
    if ($skip -contains $name.Trim()) { continue }
    $value = $value.Trim()
    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'"))) { $value = $value.Substring(1, $value.Length - 2) }
    Set-Item -LiteralPath "Env:$($name.Trim())" -Value $value
}
$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$corepackCommand = Get-Command corepack.cmd -ErrorAction SilentlyContinue
if ($null -ne $pnpmCommand) {
    & $pnpmCommand.Source --filter '@business-assistant/api' dev
} elseif ($null -ne $corepackCommand) {
    & $corepackCommand.Source pnpm --filter '@business-assistant/api' dev
} else {
    throw 'Unable to run pnpm. Install Node.js 24 or newer, or run corepack enable once as Administrator.'
}
if ($LASTEXITCODE -ne 0) { throw 'Node API server failed to start.' }
