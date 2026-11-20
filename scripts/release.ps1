param(
  [string]$Version = "",
  [ValidateSet("none", "patch", "minor", "major")]
  [string]$Bump = "patch",
  [string]$Notes = "Atualização do Cafofo Desktop.",
  [string]$Repo = "",
  [switch]$SkipPublish
)

$ErrorActionPreference = "Stop"

$RootDir = Resolve-Path (Join-Path $PSScriptRoot "..")
$TauriConfPath = Join-Path $RootDir "apps\desktop\src-tauri\tauri.conf.json"
$DesktopPkgPath = Join-Path $RootDir "apps\desktop\package.json"
$KeyPath = Join-Path $env:USERPROFILE ".tauri\cafofo.key"

if (-not (Test-Path $KeyPath)) {
  throw "Chave privada de assinatura não encontrada em '$KeyPath'. Execute 'corepack pnpm --filter @cafofo/desktop tauri signer generate -w `"$KeyPath`" --ci --force'."
}

$tauriConf = Get-Content -Raw $TauriConfPath | ConvertFrom-Json
$desktopPkg = Get-Content -Raw $DesktopPkgPath | ConvertFrom-Json

$currentVersion = [string]$tauriConf.version
if ([string]::IsNullOrWhiteSpace($Version)) {
  if ($Bump -eq "none") {
    $Version = $currentVersion
  } else {
    $parts = $currentVersion.Split(".") | ForEach-Object { [int]$_ }
    if ($parts.Count -ne 3) {
      throw "Versão atual inválida em tauri.conf.json: '$currentVersion'"
    }
    switch ($Bump) {
      "major" { $parts[0]++; $parts[1] = 0; $parts[2] = 0 }
      "minor" { $parts[1]++; $parts[2] = 0 }
      "patch" { $parts[2]++ }
    }
    $Version = "$($parts[0]).$($parts[1]).$($parts[2])"
  }
}

# Resolve OWNER/REPO via parâmetro, git remote ou endpoint do tauri.conf.json
if ([string]::IsNullOrWhiteSpace($Repo)) {
  try {
    $remoteUrl = (git -C $RootDir remote get-url origin 2>$null)
    if ($remoteUrl -match "github\.com[:/]([^/]+/[^/.]+?)(?:\.git)?$") {
      $Repo = $Matches[1]
    }
  } catch {}
}

if ([string]::IsNullOrWhiteSpace($Repo)) {
  $endpoint = $tauriConf.plugins.updater.endpoints | Select-Object -First 1
  if ($endpoint -match "github\.com/([^/]+/[^/]+)/releases") {
    $Repo = $Matches[1]
  }
}

if ([string]::IsNullOrWhiteSpace($Repo) -or $Repo -eq "OWNER/REPO") {
  Write-Warning "Repositório GitHub (OWNER/REPO) ainda não configurado. Passe -Repo 'usuario/repositorio' ou configure 'git remote add origin ...' e atualize apps/desktop/src-tauri/tauri.conf.json."
  if ([string]::IsNullOrWhiteSpace($Repo)) {
    $Repo = "OWNER/REPO"
  }
}

Write-Host "==> Atualizando versão: $currentVersion -> $Version" -ForegroundColor Cyan
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

$tauriConf.version = $Version
[System.IO.File]::WriteAllText(
  $TauriConfPath,
  ($tauriConf | ConvertTo-Json -Depth 12) + "`n",
  $utf8NoBom
)

$desktopPkg.version = $Version
[System.IO.File]::WriteAllText(
  $DesktopPkgPath,
  ($desktopPkg | ConvertTo-Json -Depth 12) + "`n",
  $utf8NoBom
)

Write-Host "==> Compilando e assinando instalador Windows (.exe)..." -ForegroundColor Cyan
$env:TAURI_SIGNING_PRIVATE_KEY = (Get-Content -Raw $KeyPath).Trim()

Push-Location $RootDir
try {
  corepack pnpm --filter @cafofo/desktop tauri build
  if ($LASTEXITCODE -ne 0) {
    throw "Falha no build do Tauri (exit code $LASTEXITCODE)."
  }
} finally {
  Pop-Location
}

$bundleCandidates = @(
  (Join-Path $RootDir "apps\desktop\src-tauri\target\release\bundle\nsis"),
  (Join-Path $RootDir "target\release\bundle\nsis")
)

$nsisDir = $bundleCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $nsisDir) {
  throw "Pasta de bundle NSIS não encontrada após o build."
}

$exeFile = Get-ChildItem -Path $nsisDir -Filter "Cafofo_${Version}_*setup.exe" | Select-Object -First 1
if (-not $exeFile) {
  $exeFile = Get-ChildItem -Path $nsisDir -Filter "Cafofo_*setup.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
}
if (-not $exeFile) {
  throw "Instalador .exe não encontrado em '$nsisDir'."
}

$sigFile = Get-Item "$($exeFile.FullName).sig" -ErrorAction SilentlyContinue
if (-not $sigFile) {
  throw "Arquivo de assinatura '$($exeFile.FullName).sig' não encontrado. Verifique bundle.createUpdaterArtifacts e TAURI_SIGNING_PRIVATE_KEY."
}

$signature = (Get-Content -Raw $sigFile.FullName).Trim()
$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$downloadUrl = "https://github.com/$Repo/releases/download/v$Version/$($exeFile.Name)"

$latestManifest = [ordered]@{
  version   = $Version
  notes     = $Notes
  pub_date  = $pubDate
  platforms = [ordered]@{
    "windows-x86_64" = [ordered]@{
      signature = $signature
      url       = $downloadUrl
    }
  }
}

$latestJsonPath = Join-Path $nsisDir "latest.json"
[System.IO.File]::WriteAllText(
  $latestJsonPath,
  ($latestManifest | ConvertTo-Json -Depth 6) + "`n",
  $utf8NoBom
)

Write-Host "==> Artefatos gerados:" -ForegroundColor Green
Write-Host "    Instalador : $($exeFile.FullName)"
Write-Host "    Assinatura : $($sigFile.FullName)"
Write-Host "    Manifesto  : $latestJsonPath"

if ($SkipPublish) {
  Write-Host "==> -SkipPublish ativo. Release não publicado no GitHub." -ForegroundColor Yellow
  exit 0
}

if ($Repo -eq "OWNER/REPO") {
  throw "Não é possível publicar no GitHub com Repo='OWNER/REPO'. Configure o remote do Git ou informe -Repo 'usuario/repositorio'."
}

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw "GitHub CLI ('gh') não encontrado no PATH. Instale via 'winget install GitHub.cli' e autentique com 'gh auth login'."
}

Write-Host "==> Publicando release v$Version em $Repo via GitHub CLI..." -ForegroundColor Cyan
gh release create "v$Version" `
  $exeFile.FullName `
  $sigFile.FullName `
  $latestJsonPath `
  --repo $Repo `
  --title "Cafofo v$Version" `
  --notes $Notes `
  --latest

if ($LASTEXITCODE -ne 0) {
  throw "Falha ao publicar release no GitHub (exit code $LASTEXITCODE)."
}

Write-Host "==> Release v$Version publicado com sucesso!" -ForegroundColor Green
