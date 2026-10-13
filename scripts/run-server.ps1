$ErrorActionPreference = 'Stop'
$repositoryRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repositoryRoot
$envFile = Join-Path $repositoryRoot '.env'
if (-not (Test-Path -LiteralPath $envFile)) { throw '.env is missing. Copy .env.example to .env and configure Supabase.' }
foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    $trimmed = $line.Trim()
    if (-not $trimmed -or $trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) { continue }
    $name, $value = $trimmed.Split('=', 2)
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
