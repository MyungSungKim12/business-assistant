param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$ApiBaseUrl,
    [switch]$UseTcpLoopback,
    [switch]$Test
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$projectRoot = Join-Path $repositoryRoot 'apps/android-companion'
$gradleVersion = '8.10.2'
$gradleChecksum = '31c55713e40233a8303827ceb42ca48a47267a0ad4bab9177123121e71524c26'

if ([string]::IsNullOrWhiteSpace($env:JAVA_HOME)) {
    $javaCandidates = @(
        (Join-Path $env:ProgramFiles 'Android/Android Studio/jbr'),
        (Join-Path $env:LOCALAPPDATA 'Programs/Android Studio/jbr')
    )
    $javaHome = $javaCandidates | Where-Object { Test-Path -LiteralPath (Join-Path $_ 'bin/java.exe') } | Select-Object -First 1
    if ($javaHome) { $env:JAVA_HOME = $javaHome }
}
if (-not $env:JAVA_HOME -or -not (Test-Path -LiteralPath (Join-Path $env:JAVA_HOME 'bin/java.exe'))) {
    throw 'JDK 17이 필요합니다. Android Studio를 설치하거나 JAVA_HOME을 Android Studio의 jbr 폴더로 지정해 주세요.'
}

if (-not $env:ANDROID_HOME -and $env:ANDROID_SDK_ROOT) { $env:ANDROID_HOME = $env:ANDROID_SDK_ROOT }
if (-not $env:ANDROID_HOME) {
    $defaultSdk = Join-Path $env:LOCALAPPDATA 'Android/Sdk'
    if (Test-Path -LiteralPath $defaultSdk) { $env:ANDROID_HOME = $defaultSdk }
}
if (-not $env:ANDROID_HOME -or -not (Test-Path -LiteralPath (Join-Path $env:ANDROID_HOME 'platform-tools'))) {
    throw 'Android SDK가 필요합니다. Android Studio SDK Manager에서 Android SDK Platform 35, Build-Tools 35, Platform-Tools를 설치해 주세요.'
}

$cacheRoot = Join-Path $env:LOCALAPPDATA 'BusinessAssistantAndroid'
$gradleHome = Join-Path $cacheRoot "gradle-$gradleVersion"
$gradleCommand = Join-Path $gradleHome 'bin/gradle.bat'
if (-not (Test-Path -LiteralPath $gradleCommand)) {
    New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
    $archive = Join-Path $cacheRoot "gradle-$gradleVersion-bin.zip"
    Invoke-WebRequest -Uri "https://services.gradle.org/distributions/gradle-$gradleVersion-bin.zip" -OutFile $archive
    $actualChecksum = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualChecksum -ne $gradleChecksum) {
        throw "Gradle 배포 파일 SHA-256 검증에 실패했습니다. 예상값: $gradleChecksum / 실제값: $actualChecksum"
    }
    Expand-Archive -LiteralPath $archive -DestinationPath $cacheRoot
    Remove-Item -LiteralPath $archive
}

Push-Location $projectRoot
$previousJavaOptions = $env:JAVA_TOOL_OPTIONS
try {
    if ($UseTcpLoopback) {
        # Some managed Windows environments accept AF_UNIX bind but reject connect.
        # Point Unix socket storage at a regular file so OpenJDK's documented-in-source
        # PipeImpl fallback chooses a normal TCP loopback socket instead. Process-local only.
        $tcpMarker = Join-Path $cacheRoot 'tcp-loopback-marker'
        if (-not (Test-Path -LiteralPath $tcpMarker)) { Set-Content -LiteralPath $tcpMarker -Value 'TCP loopback fallback' -Encoding ascii }
        $env:JAVA_TOOL_OPTIONS = "$previousJavaOptions `"-Djdk.net.unixdomain.tmpdir=$tcpMarker`"".Trim()
    }
    $tasks = @('assembleDebug')
    if ($Test) { $tasks += 'testDebugUnitTest' }
    & $gradleCommand --no-daemon --stacktrace @tasks "-PapiBaseUrl=$ApiBaseUrl"
    if ($LASTEXITCODE -ne 0) { throw "Android 앱 빌드에 실패했습니다 (exit $LASTEXITCODE). 위 Gradle 오류를 확인해 주세요." }
} finally {
    $env:JAVA_TOOL_OPTIONS = $previousJavaOptions
    Pop-Location
}

$apkPath = Join-Path $projectRoot 'app/build/outputs/apk/debug/app-debug.apk'
Write-Output "APK 생성 완료: $apkPath"
