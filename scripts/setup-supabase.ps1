[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TargetDir = Join-Path $RepoRoot ".tools\supabase"
$TargetExe = Join-Path $TargetDir "supabase.exe"

if ((Test-Path $TargetExe) -and -not $Force) {
    Write-Host "supabase.exe já existe em $TargetExe (use -Force para baixar novamente)."
    & $TargetExe --version
    exit 0
}

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

$Arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "arm64" } else { "amd64" }

$Headers = @{
    "User-Agent" = "Cafofo-Setup-Script"
    "Accept"     = "application/vnd.github+json"
}

Write-Host "Consultando última release de supabase/cli no GitHub..."
$Release = Invoke-RestMethod -Uri "https://api.github.com/repos/supabase/cli/releases/latest" -Headers $Headers

$AssetPattern = "windows_$Arch\.zip$"
$Asset = $Release.assets | Where-Object { $_.name -match $AssetPattern } | Select-Object -First 1
if (-not $Asset) {
    throw "Nenhum asset compatível com $AssetPattern encontrado na release $($Release.tag_name)."
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("cafofo-supabase-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

try {
    $ZipPath = Join-Path $TempDir $Asset.name
    Write-Host "Baixando $($Asset.name) ($($Release.tag_name))..."
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $ZipPath -Headers @{ "User-Agent" = "Cafofo-Setup-Script" }

    $ExtractDir = Join-Path $TempDir "extracted"
    Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

    $ExeFile = Get-ChildItem -Path $ExtractDir -Filter "supabase.exe" -Recurse | Select-Object -First 1
    if (-not $ExeFile) {
        throw "supabase.exe não encontrado dentro de $($Asset.name)."
    }

    Copy-Item -Path $ExeFile.FullName -Destination $TargetExe -Force
    Write-Host "supabase.exe ($($Release.tag_name)) instalado em $TargetExe"
    & $TargetExe --version
}
finally {
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
