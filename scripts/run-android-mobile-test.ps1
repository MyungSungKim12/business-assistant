# Development-only LTE/5G test: local API -> restricted gateway -> temporary HTTPS URL.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$cacheRoot = Join-Path $env:LOCALAPPDATA 'BusinessAssistantAndroid'
$sessionPath = Join-Path $cacheRoot 'mobile-test-session.json'
$health = Invoke-RestMethod 'http://127.0.0.1:8000/api/v1/health' -TimeoutSec 5
if ($health.status -ne 'ok') { throw 'Start run-app.cmd first (API port 8000).' }
$existingListener = Get-NetTCPConnection -LocalPort 8789 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($existingListener) {
    $existingProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$($existingListener.OwningProcess)"
    $gatewayPath = Join-Path $PSScriptRoot 'android-test-gateway.mjs'
    if ($existingProcess.Name -ne 'node.exe' -or $existingProcess.CommandLine.IndexOf($gatewayPath, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        throw 'Port 8789 belongs to another application. It was not stopped.'
    }
    $saved = $null
    if (Test-Path -LiteralPath $sessionPath) {
        try { $candidate = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json; if ($candidate.gatewayPid -eq $existingProcess.ProcessId -and $candidate.repository -eq $repositoryRoot) { $saved = $candidate } } catch { }
    }
    if ($saved -and -not $saved.ready) {
        Write-Host 'The existing mobile test is still building its APK. Wait for the first terminal to finish.'
        return
    }
    $existingUrl = if ($saved) { $saved.publicUrl } else { $null }
    # Compatibility with a test session started before session metadata was added.
    if (-not $existingUrl) {
        $buildConfig = Join-Path $repositoryRoot 'apps/android-companion/app/build/generated/source/buildConfig/debug/com/businessassistant/phone/BuildConfig.java'
        if ((Test-Path -LiteralPath $buildConfig) -and ((Get-Content -LiteralPath $buildConfig -Raw) -match 'https://[a-z0-9-]+\.trycloudflare\.com')) { $existingUrl = $Matches[0] }
    }
    if (-not $existingUrl) {
        $logs = Get-ChildItem -LiteralPath $cacheRoot -Filter 'tunnel-*.log' | Where-Object { $_.CreationTime -ge $existingProcess.CreationDate.AddSeconds(-5) -and $_.CreationTime -le $existingProcess.CreationDate.AddMinutes(2) } | Sort-Object CreationTime -Descending
        foreach ($log in $logs) {
            if ((Get-Content -LiteralPath $log.FullName -Raw) -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $existingUrl = $Matches[0]; break }
        }
    }
    if (-not $existingUrl -or $existingUrl -notmatch '^https://[a-z0-9-]+\.trycloudflare\.com$') { throw 'The existing test gateway was found, but its HTTPS URL could not be verified. Check its original terminal.' }
    try {
        $local = Invoke-RestMethod 'http://127.0.0.1:8789/api/v1/health' -TimeoutSec 5
        $remote = Invoke-RestMethod "$existingUrl/api/v1/health" -TimeoutSec 15
        if ($local.status -ne 'ok' -or $remote.status -ne 'ok') { throw 'Health check failed' }
    } catch { throw 'The previous mobile test exists, but its API/tunnel is not responding. Check the original terminal; no process was stopped.' }
    Write-Host 'The mobile test is already running. Reusing the existing connection.'
    Write-Host "API: $existingUrl/api/v1/"
    $buildConfig = Join-Path $repositoryRoot 'apps/android-companion/app/build/generated/source/buildConfig/debug/com/businessassistant/phone/BuildConfig.java'
    $apkPath = Join-Path $repositoryRoot 'apps/android-companion/app/build/outputs/apk/debug/app-debug.apk'
    $expectedBase = "$existingUrl/api/v1/"
    $correctApk = (Test-Path -LiteralPath $apkPath) -and (Test-Path -LiteralPath $buildConfig) -and (Get-Content -LiteralPath $buildConfig -Raw).Contains('"' + $expectedBase + '"')
    if (-not $correctApk) {
        Write-Host 'The local APK uses a different API address or is missing. Rebuilding for the existing connection.'
        & (Join-Path $PSScriptRoot 'build-android-companion.ps1') -ApiBaseUrl $expectedBase -UseTcpLoopback -Test
        Write-Host 'Download and update-install this rebuilt APK on the phone.'
    }
    if ($saved) { Write-Host "APK: $($saved.downloadUrl)" }
    if ($correctApk) { Write-Host 'Keep the PC app and the original test session running. Your installed APK can be reused if it uses this API address.' }
    else { Write-Host 'Keep the PC app and the original test session running. Install the rebuilt APK if your phone uses a different API address.' }
    return
}
$node = Get-Command node.exe -ErrorAction Stop
New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
$cloudflared = Join-Path $cacheRoot 'cloudflared-2026.10.2.exe'
if (-not (Test-Path -LiteralPath $cloudflared)) {
    Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/download/2026.10.2/cloudflared-windows-amd64.exe' -OutFile $cloudflared
}
if ((Get-FileHash -LiteralPath $cloudflared -Algorithm SHA256).Hash.ToLowerInvariant() -ne '12c7c887f8aaab779aef1dfa9b60673530a5adb88ecc55dd6df8f56e0b70f199') {
    throw 'Cloudflared SHA-256 verification failed.'
}
$runId = [Guid]::NewGuid().ToString('N')
$logPath = Join-Path $cacheRoot "tunnel-$runId.log"
$gatewayLog = Join-Path $cacheRoot "gateway-$runId.log"
$downloadToken = [Guid]::NewGuid().ToString('N') + [Guid]::NewGuid().ToString('N')
$previousToken = $env:ANDROID_TEST_DOWNLOAD_TOKEN
$gatewayProcess = $null
$tunnelProcess = $null
try {
    $env:ANDROID_TEST_DOWNLOAD_TOKEN = $downloadToken
    $gatewayScript = Join-Path $PSScriptRoot 'android-test-gateway.mjs'
    $gatewayProcess = Start-Process -FilePath $node.Source -ArgumentList @('"' + $gatewayScript + '"') -WorkingDirectory $repositoryRoot -WindowStyle Hidden -RedirectStandardOutput $gatewayLog -RedirectStandardError "$gatewayLog.err" -PassThru
    $env:ANDROID_TEST_DOWNLOAD_TOKEN = $previousToken
    Start-Sleep -Milliseconds 800
    if ($gatewayProcess.HasExited) { throw "Local gateway failed. See $gatewayLog.err" }
    $tunnelProcess = Start-Process -FilePath $cloudflared -ArgumentList @('tunnel', '--protocol', 'http2', '--url', 'http://127.0.0.1:8789', '--no-autoupdate') -WorkingDirectory $repositoryRoot -WindowStyle Hidden -RedirectStandardError $logPath -RedirectStandardOutput "$logPath.out" -PassThru
    $deadline = (Get-Date).AddSeconds(90)
    $publicUrl = $null
    while (-not $publicUrl -and (Get-Date) -lt $deadline) {
        if ($tunnelProcess.HasExited) { throw "Tunnel failed. See $logPath" }
        $logText = if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath -Raw } else { '' }
        if ($logText -match 'https://[a-z0-9-]+\.trycloudflare\.com') { $publicUrl = $Matches[0] }
        if (-not $publicUrl) { Start-Sleep -Milliseconds 500 }
    }
    if (-not $publicUrl) { throw "Tunnel URL was not issued. See $logPath" }
    $session = @{ repository = $repositoryRoot; gatewayPid = $gatewayProcess.Id; tunnelPid = $tunnelProcess.Id; publicUrl = $publicUrl; downloadUrl = "$publicUrl/download/$downloadToken/app-debug.apk"; ready = $false }
    $session | ConvertTo-Json | Set-Content -LiteralPath $sessionPath -Encoding UTF8
    Write-Host "API: $publicUrl/api/v1/"
    & (Join-Path $PSScriptRoot 'build-android-companion.ps1') -ApiBaseUrl "$publicUrl/api/v1/" -UseTcpLoopback -Test
    $session.ready = $true
    $session | ConvertTo-Json | Set-Content -LiteralPath $sessionPath -Encoding UTF8
    Write-Host ''
    Write-Host 'Open this URL in Samsung Internet/Chrome on your phone (LTE/5G):'
    Write-Host "$publicUrl/download/$downloadToken/app-debug.apk"
    Write-Host 'Install the APK, sign in with the SAME account as the PC, select the SAME organization, sync and enable PC relay consent.'
    Write-Host 'Keep run-app.cmd and this terminal running. Ctrl+C stops this test tunnel.'
    while (-not $tunnelProcess.HasExited -and -not $gatewayProcess.HasExited) { Start-Sleep -Seconds 1 }
    throw 'The tunnel or local gateway stopped. Start this command again to create a new test APK and URL.'
} finally {
    $env:ANDROID_TEST_DOWNLOAD_TOKEN = $previousToken
    foreach ($child in @($tunnelProcess, $gatewayProcess)) {
        if ($null -ne $child -and -not $child.HasExited) { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue }
    }
    if ($null -ne $gatewayProcess -and (Test-Path -LiteralPath $sessionPath)) {
        try { $saved = Get-Content -LiteralPath $sessionPath -Raw | ConvertFrom-Json; if ($saved.gatewayPid -eq $gatewayProcess.Id) { Remove-Item -LiteralPath $sessionPath } } catch { }
    }
}
