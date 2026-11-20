[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$TargetDir = Join-Path $RepoRoot ".tools\livekit"
$TargetExe = Join-Path $TargetDir "livekit-server.exe"

if ((Test-Path $TargetExe) -and -not $Force) {
    Write-Host "livekit-server.exe já existe em $TargetExe (use -Force para baixar novamente)."
    exit 0
}

New-Item -ItemType Directory -Force -Path $TargetDir | Out-Null

$Headers = @{
    "User-Agent" = "Cafofo-Setup-Script"
    "Accept"     = "application/vnd.github+json"
}

Write-Host "Consultando última release de livekit/livekit no GitHub..."
$Release = Invoke-RestMethod -Uri "https://api.github.com/repos/livekit/livekit/releases/latest" -Headers $Headers

$Asset = $Release.assets | Where-Object { $_.name -match "windows_amd64\.zip$" } | Select-Object -First 1
if (-not $Asset) {
    throw "Nenhum asset *_windows_amd64.zip encontrado na release $($Release.tag_name)."
}

$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("cafofo-livekit-" + [System.Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $TempDir | Out-Null

try {
    $ZipPath = Join-Path $TempDir $Asset.name
    Write-Host "Baixando $($Asset.name) ($($Release.tag_name))..."
    Invoke-WebRequest -Uri $Asset.browser_download_url -OutFile $ZipPath -Headers @{ "User-Agent" = "Cafofo-Setup-Script" }

    $ExtractDir = Join-Path $TempDir "extracted"
    Expand-Archive -Path $ZipPath -DestinationPath $ExtractDir -Force

    $ExeFile = Get-ChildItem -Path $ExtractDir -Filter "livekit-server.exe" -Recurse | Select-Object -First 1
    if (-not $ExeFile) {
        throw "livekit-server.exe não encontrado dentro de $($Asset.name)."
    }

    Copy-Item -Path $ExeFile.FullName -Destination $TargetExe -Force
    Write-Host "livekit-server.exe ($($Release.tag_name)) instalado em $TargetExe"
}
finally {
    if (Test-Path $TempDir) {
        Remove-Item -Path $TempDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}
