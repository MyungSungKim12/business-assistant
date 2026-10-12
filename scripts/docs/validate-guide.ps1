$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$problems = New-Object System.Collections.Generic.List[string]

$requiredFiles = @(
    "mkdocs.yml",
    "requirements-docs.txt",
    ".github/workflows/docs-pages.yml",
    "docs/index.md",
    "docs/guide/getting-started/quick-start.md",
    "docs/guide/getting-started/interface.md",
    "docs/guide/user-guide/customers.md",
    "docs/guide/user-guide/treatments.md",
    "docs/guide/user-guide/documents.md",
    "docs/guide/user-guide/sales-payments.md",
    "docs/guide/user-guide/tasks-files-finance.md",
    "docs/guide/user-guide/menu-status.md",
    "docs/guide/workflows/customer-to-payment.md",
    "docs/guide/workflows/refunds-and-recovery.md",
    "docs/guide/admin/supabase.md",
    "docs/guide/admin/permissions-and-operations.md",
    "docs/guide/developer/architecture.md",
    "docs/guide/developer/git-worktree.md",
    "docs/guide/developer/testing-and-release.md",
    "docs/guide/troubleshooting.md",
    "docs/guide/assets/stylesheets/extra.css",
    "docs/guide/assets/javascripts/extra.js"
)

foreach ($relativePath in $requiredFiles) {
    $fullPath = Join-Path $repositoryRoot $relativePath
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        $problems.Add("Missing required file: $relativePath")
    }
}

$mkdocsPath = Join-Path $repositoryRoot "mkdocs.yml"
if (Test-Path -LiteralPath $mkdocsPath) {
    $mkdocs = Get-Content -LiteralPath $mkdocsPath -Raw -Encoding UTF8
    foreach ($requiredText in @("site_name:", "theme:", "name: material", "nav:", "index.md")) {
        if (-not $mkdocs.Contains($requiredText)) {
            $problems.Add("Missing mkdocs.yml setting: $requiredText")
        }
    }
}

$workflowPath = Join-Path $repositoryRoot ".github/workflows/docs-pages.yml"
if (Test-Path -LiteralPath $workflowPath) {
    $workflow = Get-Content -LiteralPath $workflowPath -Raw -Encoding UTF8
    foreach ($requiredText in @("pull_request:", "pages: write", "mkdocs build --strict", "deploy-pages")) {
        if (-not $workflow.Contains($requiredText)) {
            $problems.Add("Missing documentation workflow setting: $requiredText")
        }
    }
}

$docsRoot = Join-Path $repositoryRoot "docs"
if (Test-Path -LiteralPath $docsRoot) {
    $markdownFiles = Get-ChildItem -LiteralPath $docsRoot -Recurse -Filter "*.md" -File | Where-Object {
        $relative = $_.FullName.Substring($docsRoot.Length + 1).Replace("\", "/")
        -not $relative.StartsWith("superpowers/") -and $relative -notmatch '^0[^/]*\.md$'
    }
    foreach ($file in $markdownFiles) {
        $content = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8
        if (
            $content -match '(?i)APP_SUPABASE_SERVICE_KEY\s*=\s*(eyJ|sb_secret_)' -or
            $content -match '(?i)postgres(?:ql)?://[^\s:]+:[^\s@]+@' -or
            $content -match '(?i)(?:API_KEY|SERVICE_ROLE_KEY|TOKEN)\s*[:=]\s*(?:sk-|ghp_|eyJ|sb_secret_)'
        ) {
            $problems.Add("Possible secret found: $($file.FullName)")
        }
        $matches = [regex]::Matches($content, '!?' + '\[[^\]]*\]\(([^)]+)\)')
        foreach ($match in $matches) {
            $target = $match.Groups[1].Value.Trim()
            if ($target.StartsWith("<") -and $target.EndsWith(">")) {
                $target = $target.Substring(1, $target.Length - 2)
            }
            $pathOnly = $target.Split('#')[0].Split('?')[0]
            if ([string]::IsNullOrWhiteSpace($pathOnly) -or $pathOnly -match '^(https?:|mailto:|codex:)') {
                continue
            }
            if ($pathOnly.StartsWith("/")) {
                $resolved = Join-Path (Join-Path $repositoryRoot "docs") $pathOnly.TrimStart('/')
            } else {
                $resolved = Join-Path $file.DirectoryName $pathOnly
            }
            if (-not (Test-Path -LiteralPath $resolved)) {
                $relativeFile = $file.FullName.Substring($repositoryRoot.Length + 1)
                $problems.Add("Broken link: $relativeFile -> $target")
            }
        }
    }
}

if ($problems.Count -gt 0) {
    Write-Host "Guide validation failed ($($problems.Count) issue(s))" -ForegroundColor Red
    $problems | ForEach-Object { Write-Host "- $_" }
    exit 1
}

Write-Host "Guide validation passed: published structure, local links, deployment settings, and known credential patterns checked" -ForegroundColor Green
