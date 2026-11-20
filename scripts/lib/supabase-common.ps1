function Get-CafofoRepoRoot {
    return Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}

function Import-CafofoEnv {
    param(
        [string]$RepoRoot = (Get-CafofoRepoRoot)
    )

    $EnvPath = Join-Path $RepoRoot ".env"
    if (-not (Test-Path $EnvPath)) {
        return
    }

    foreach ($RawLine in Get-Content -Path $EnvPath) {
        $Line = $RawLine.Trim()
        if ([string]::IsNullOrWhiteSpace($Line) -or $Line.StartsWith("#")) {
            continue
        }
        if ($Line -match '^([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            $Key = $matches[1]
            $Value = $matches[2].Trim()
            if (
                ($Value.StartsWith('"') -and $Value.EndsWith('"') -and $Value.Length -ge 2) -or
                ($Value.StartsWith("'") -and $Value.EndsWith("'") -and $Value.Length -ge 2)
            ) {
                $Value = $Value.Substring(1, $Value.Length - 2)
            }
            if (-not [string]::IsNullOrWhiteSpace($Value)) {
                [System.Environment]::SetEnvironmentVariable($Key, $Value, "Process")
            }
        }
    }
}

function Ensure-SupabaseCli {
    param(
        [string]$RepoRoot = (Get-CafofoRepoRoot)
    )

    $ExePath = Join-Path $RepoRoot ".tools\supabase\supabase.exe"
    if (-not (Test-Path $ExePath)) {
        $SetupScript = Join-Path $RepoRoot "scripts\setup-supabase.ps1"
        Write-Host "supabase.exe não encontrado em $ExePath. Executando setup-supabase.ps1..."
        & $SetupScript
        if ($LASTEXITCODE -ne 0 -or -not (Test-Path $ExePath)) {
            throw "Falha ao instalar supabase.exe via $SetupScript."
        }
    }

    return $ExePath
}

function Get-SupabaseProjectRefFromEnv {
    $Url = $env:SUPABASE_URL
    if ([string]::IsNullOrWhiteSpace($Url)) {
        return $null
    }
    if ($Url -match '^https?://([a-z0-9]{20})\.supabase\.(co|in)') {
        return $matches[1]
    }
    return $null
}
