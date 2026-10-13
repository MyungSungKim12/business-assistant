# 한 번에 실행: API 서버를 띄우고 준비될 때까지 기다린 뒤 데스크톱 앱 창을 연다.
# 앱 창을 닫으면 이 스크립트가 띄운 API 서버도 함께 종료한다. 이미 8000 포트에서 API가 응답하면 새로 띄우지 않는다.
param([switch]$NoApi)
$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot

$userCargoBin = Join-Path $env:USERPROFILE '.cargo\bin'
if (Test-Path -LiteralPath $userCargoBin) { $env:Path = "$userCargoBin;$env:Path" }
if ($null -eq (Get-Command cargo.exe -ErrorAction SilentlyContinue)) {
    throw 'Rust(MSVC 툴체인)가 필요합니다. https://rustup.rs 에서 설치한 뒤 PowerShell을 다시 여세요.'
}
$pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue)
$pnpmArgs = @()
if ($null -eq $pnpm) {
    $pnpm = Get-Command corepack.cmd -ErrorAction SilentlyContinue
    if ($null -eq $pnpm) { throw 'pnpm을 실행할 수 없습니다. Node.js 24 이상을 설치하세요.' }
    $pnpmArgs = @('pnpm')
}

$envFile = Join-Path $repositoryRoot '.env'
$skipSecrets = @('APP_SUPABASE_SERVICE_KEY', 'APP_PLATFORM_ADMIN_USER_IDS', 'APP_DATABASE_URL', 'BUSINESS_ASSISTANT_DEV_AUTO_LOGIN', 'BUSINESS_ASSISTANT_DEV_EMAIL', 'BUSINESS_ASSISTANT_DEV_PASSWORD')
if (Test-Path -LiteralPath $envFile) {
    foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
        $trimmed = $line.Trim()
        if (-not $trimmed -or $trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) { continue }
        $name, $value = $trimmed.Split('=', 2)
        $value = $value.Trim().Trim('"').Trim("'")
        # 앱·일반 API 프로세스가 상속하지 않아야 하는 비밀값(서비스 키, DB 주소, 개발용 계정)은 읽지 않는다.
        if ($skipSecrets -contains $name.Trim()) { continue }
        Set-Item -LiteralPath "Env:$($name.Trim())" -Value $value
    }
}
# 사진 서명 URL을 허용할 Storage 호스트: 지정하지 않았으면 Supabase 프로젝트 주소에서 자동으로 정한다.
if (-not $env:BUSINESS_ASSISTANT_STORAGE_HOST -and $env:APP_SUPABASE_URL) {
    try { $env:BUSINESS_ASSISTANT_STORAGE_HOST = ([Uri]$env:APP_SUPABASE_URL).Host.ToLowerInvariant() } catch { }
}
$port = if ($env:APP_API_PORT) { $env:APP_API_PORT } else { '8000' }
$health = "http://127.0.0.1:$port/api/v1/health"
function Test-Api { try { (Invoke-RestMethod -Uri $health -TimeoutSec 2).status -eq 'ok' } catch { $false } }

$apiProcess = $null
if (-not $NoApi -and -not (Test-Api)) {
    if (-not (Test-Path -LiteralPath $envFile)) { throw '.env가 없습니다. .env.example을 복사해 Supabase 설정을 채우세요.' }
    Write-Host 'API 서버를 시작합니다...'
    $apiProcess = Start-Process -FilePath $pnpm.Source -ArgumentList ($pnpmArgs + @('--filter', '@business-assistant/api', 'dev')) -WorkingDirectory $repositoryRoot -WindowStyle Hidden -PassThru
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Test-Api)) {
        if ($apiProcess.HasExited) { throw 'API 서버가 시작 직후 종료되었습니다. `scripts\run-server.ps1`로 오류를 확인하세요.' }
        if ((Get-Date) -gt $deadline) { throw 'API 서버가 60초 안에 준비되지 않았습니다.' }
        Start-Sleep -Milliseconds 500
    }
    Write-Host 'API 서버 준비 완료.'
}

$tauriArgs = @('--dir', 'apps/desktop-react', 'tauri', 'dev')
# 1420 포트에서 프런트 개발 서버가 이미 떠 있으면 새로 띄우지 않고 그대로 쓴다(포트 충돌 방지).
if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) {
    Write-Host '1420 포트의 프런트 개발 서버를 재사용합니다.'
    $reuse = Join-Path $env:TEMP 'ba-tauri-reuse.json'
    Set-Content -LiteralPath $reuse -Value '{"build":{"beforeDevCommand":""}}' -Encoding ascii
    $tauriArgs += @('--config', $reuse)
}

try {
    & $pnpm.Source @pnpmArgs @tauriArgs
} finally {
    if ($null -ne $apiProcess -and -not $apiProcess.HasExited) {
        # pnpm → tsx → node 프로세스 트리 전체를 종료한다.
        & taskkill.exe /PID $apiProcess.Id /T /F | Out-Null
        Write-Host 'API 서버를 종료했습니다.'
    }
}
