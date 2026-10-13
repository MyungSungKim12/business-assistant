$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot

# 개발 준비: Node 의존성 설치와 앱 아이콘 생성. Rust(MSVC)는 데스크톱 앱 창을 열 때 필요합니다.
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

& $pnpm @pnpmArgs install
if ($LASTEXITCODE -ne 0) {
    throw "의존성 설치에 실패했습니다."
}

& $pnpm @pnpmArgs --dir apps/desktop-react icons
if ($LASTEXITCODE -ne 0) {
    throw "앱 아이콘 생성에 실패했습니다."
}

$userCargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
if ($null -eq (Get-Command cargo -ErrorAction SilentlyContinue) -and -not (Test-Path -LiteralPath (Join-Path $userCargoBin "cargo.exe"))) {
    Write-Warning "Rust(MSVC 툴체인)가 없습니다. 데스크톱 앱 창을 열려면 https://rustup.rs 에서 설치하고 Visual Studio Build Tools(C++ 워크로드)를 준비하세요."
}
