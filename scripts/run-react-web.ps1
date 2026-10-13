$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot
$pnpmCommand = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
$corepackCommand = Get-Command corepack.cmd -ErrorAction SilentlyContinue
if ($null -ne $pnpmCommand) {
    & $pnpmCommand.Source --filter @business-assistant/desktop-react dev
} elseif ($null -ne $corepackCommand) {
    & $corepackCommand.Source pnpm --filter @business-assistant/desktop-react dev
} else {
    throw 'pnpm을 실행할 수 없습니다. Node.js 24 이상을 설치하거나 corepack enable을 관리자 PowerShell에서 한 번 실행하세요.'
}
