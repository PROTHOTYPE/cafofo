[CmdletBinding()]
param(
    [switch]$StatusOnly,
    [switch]$DryRun,
    [switch]$BaselineInitial,
    [switch]$LinkOnly,
    [switch]$Yes
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "lib\supabase-common.ps1")

$RepoRoot = Get-CafofoRepoRoot
Import-CafofoEnv -RepoRoot $RepoRoot
$SupabaseExe = Ensure-SupabaseCli -RepoRoot $RepoRoot

$UseYes = $Yes.IsPresent -or [Console]::IsInputRedirected
if ($UseYes) {
    $env:SUPABASE_YES = "true"
}

function Invoke-SupabaseCaptured {
    param(
        [string[]]$Arguments
    )

    $PrevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $Output = & $SupabaseExe @Arguments 2>&1
        $Code = $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PrevEap
    }

    $Lines = foreach ($Item in $Output) {
        if ($Item -is [System.Management.Automation.ErrorRecord]) {
            $Item.ToString()
        }
        else {
            "$Item"
        }
    }
    foreach ($Line in $Lines) {
        Write-Host $Line
    }

    return @{
        ExitCode = $Code
        Text     = ($Lines -join [Environment]::NewLine)
    }
}

function Invoke-SupabaseQuietCheck {
    param(
        [string[]]$Arguments
    )

    $PrevEap = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
        $Null = & $SupabaseExe @Arguments 2>$null
        return $LASTEXITCODE
    }
    finally {
        $ErrorActionPreference = $PrevEap
    }
}

Push-Location $RepoRoot
try {
    $DbUrl = $env:SUPABASE_DB_URL
    $ProjectRef = Get-SupabaseProjectRefFromEnv
    $RemoteTarget = $null
    $RemoteArgs = @()

    if (-not [string]::IsNullOrWhiteSpace($DbUrl)) {
        if ($DbUrl -match '^([^:]+://[^:]+):(\[[^\]]+\])(@.+)$') {
            $Prefix = $matches[1]
            $Suffix = $matches[3]
            if (-not [string]::IsNullOrWhiteSpace($env:SUPABASE_DB_PASSWORD)) {
                $EncodedPass = [System.Uri]::EscapeDataString($env:SUPABASE_DB_PASSWORD)
                $DbUrl = "${Prefix}:${EncodedPass}${Suffix}"
            }
            else {
                Write-Host ""
                Write-Host "SUPABASE_DB_URL no .env contém colchetes ([...]) no campo da senha." -ForegroundColor Yellow
                Write-Host "Remova os colchetes [ e ] deixando apenas a senha (ou defina SUPABASE_DB_PASSWORD=... no .env)." -ForegroundColor Yellow
                exit 1
            }
        }
        elseif ($DbUrl -match '^([^:]+://[^:]+):(.+)(@[^/@]+(?::\d+)?/.*)$') {
            $Prefix = $matches[1]
            $RawPass = $matches[2]
            $Suffix = $matches[3]
            if ($RawPass -notmatch '%[0-9A-Fa-f]{2}') {
                $EncodedPass = [System.Uri]::EscapeDataString($RawPass)
                $DbUrl = "${Prefix}:${EncodedPass}${Suffix}"
            }
        }
        $RemoteTarget = "SUPABASE_DB_URL"
        $RemoteArgs += "--remote=$DbUrl"
        Write-Host "Usando conexão direta configurada em SUPABASE_DB_URL."
    }
    else {
        if ([string]::IsNullOrWhiteSpace($ProjectRef)) {
            throw "SUPABASE_URL ausente ou inválida no .env. Configure SUPABASE_URL=https://<project-ref>.supabase.co ou SUPABASE_DB_URL."
        }

        $AuthCheckCode = Invoke-SupabaseQuietCheck -Arguments @("projects", "list", "--output", "json")
        if ($AuthCheckCode -ne 0 -and [string]::IsNullOrWhiteSpace($env:SUPABASE_ACCESS_TOKEN)) {
            Write-Host ""
            Write-Host "Autenticação Supabase CLI necessária." -ForegroundColor Yellow
            Write-Host "Escolha uma das opções abaixo para concluir a conexão:"
            Write-Host "  1) Fazer login no navegador: corepack pnpm supabase login"
            Write-Host "  2) Definir SUPABASE_ACCESS_TOKEN=sbp_... e SUPABASE_DB_PASSWORD=... no .env"
            Write-Host "  3) Ou definir SUPABASE_DB_URL=postgresql://... (Session Pooler) no .env"
            exit 1
        }

        $TempRefFile = Join-Path $RepoRoot "supabase\.temp\project-ref"
        $LinkedRef = if (Test-Path $TempRefFile) { (Get-Content $TempRefFile -Raw).Trim() } else { "" }

        if ($LinkedRef -ne $ProjectRef) {
            Write-Host "Vinculando repositório ao projeto Supabase ($ProjectRef)..."
            $LinkArgs = @("link", "--project-ref", $ProjectRef)
            if ($UseYes) { $LinkArgs += "--yes" }
            $LinkRes = Invoke-SupabaseCaptured -Arguments $LinkArgs
            if ($LinkRes.ExitCode -ne 0) {
                exit $LinkRes.ExitCode
            }
        }

        $RemoteTarget = $ProjectRef
        $RemoteArgs += "--remote"
        if (-not [string]::IsNullOrWhiteSpace($env:SUPABASE_DB_PASSWORD)) {
            $RemoteArgs += @("--password", $env:SUPABASE_DB_PASSWORD)
        }
    }

    if ($LinkOnly) {
        Write-Host "Projeto Supabase vinculado com sucesso ($RemoteTarget)."
        exit 0
    }

    if ($BaselineInitial) {
        Write-Host "Registrando migrations iniciais (20261116000001, 20261116000002, 20261116000003) como aplicadas..."
        $RepairArgs = @("migration", "repair", "--status", "applied", "20261116000001", "20261116000002", "20261116000003") + $RemoteArgs
        if ($UseYes) { $RepairArgs += "--yes" }
        $RepairRes = Invoke-SupabaseCaptured -Arguments $RepairArgs
        if ($RepairRes.ExitCode -ne 0) {
            exit $RepairRes.ExitCode
        }
    }

    if ($StatusOnly) {
        $ListArgs = @("migration", "list") + $RemoteArgs
        $ListRes = Invoke-SupabaseCaptured -Arguments $ListArgs
        exit $ListRes.ExitCode
    }

    $PushArgs = @("db", "push", "--include-all") + $RemoteArgs
    if ($DryRun) {
        $PushArgs += "--dry-run"
    }
    if ($UseYes) {
        $PushArgs += "--yes"
    }

    $PushRes = Invoke-SupabaseCaptured -Arguments $PushArgs
    if ($PushRes.ExitCode -ne 0) {
        if ($PushRes.Text -match "already exists") {
            Write-Host ""
            Write-Host "Dica: se as migrations iniciais já haviam sido aplicadas no SQL Editor, rode:" -ForegroundColor Yellow
            Write-Host "  corepack pnpm db:baseline" -ForegroundColor Cyan
        }
        exit $PushRes.ExitCode
    }

    Write-Host "Migrations sincronizadas com o banco remoto!" -ForegroundColor Green
    exit 0
}
finally {
    Pop-Location
}
