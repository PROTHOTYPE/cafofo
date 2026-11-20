param(
  [string]$Version = "",
  [ValidateSet("none", "patch", "minor", "major")]
  [string]$Bump = "patch",
  [string]$Notes = "Atualização do Cafofo Desktop.",
  [string]$BucketName = "cafofo-releases",
  [string]$PublicBaseUrl = "https://pub-88d3470004c540019838c149f440043a.r2.dev",
  [switch]$SkipBuild,
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
  if ($Bump -eq "none" -or $SkipBuild) {
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

$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if ($Version -ne $currentVersion) {
  Write-Host "==> Atualizando versão: $currentVersion -> $Version" -ForegroundColor Cyan

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
} else {
  Write-Host "==> Usando versão atual: $Version" -ForegroundColor Cyan
}

if (-not $SkipBuild) {
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
} else {
  Write-Host "==> -SkipBuild ativo: usando artefatos já compilados." -ForegroundColor Yellow
}

$bundleCandidates = @(
  (Join-Path $RootDir "apps\desktop\src-tauri\target\release\bundle\nsis"),
  (Join-Path $RootDir "target\release\bundle\nsis")
)

$nsisDir = $bundleCandidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $nsisDir) {
  throw "Pasta de bundle NSIS não encontrada."
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

$baseUrl = $PublicBaseUrl.TrimEnd("/")
$r2ReleasePrefix = "releases/v$Version"
$downloadUrl = "$baseUrl/$r2ReleasePrefix/$($exeFile.Name)"
$signature = (Get-Content -Raw $sigFile.FullName).Trim()
$pubDate = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
$fileSizeBytes = $exeFile.Length

$latestManifest = [ordered]@{
  version   = $Version
  notes     = $Notes
  pub_date  = $pubDate
  size      = $fileSizeBytes
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

Write-Host "==> Artefatos prontos:" -ForegroundColor Green
Write-Host "    Instalador : $($exeFile.FullName) ($([Math]::Round($fileSizeBytes / 1MB, 2)) MB)"
Write-Host "    Assinatura : $($sigFile.FullName)"
Write-Host "    Manifesto  : $latestJsonPath"
Write-Host "    URL Final  : $downloadUrl"

if ($SkipPublish) {
  Write-Host "==> -SkipPublish ativo. Upload para o Cloudflare R2 ignorado." -ForegroundColor Yellow
  exit 0
}

Write-Host "==> Publicando artefatos no Cloudflare R2 (bucket '$BucketName')..." -ForegroundColor Cyan

npx --yes wrangler r2 object put "$BucketName/$r2ReleasePrefix/$($exeFile.Name)" `
  --file "$($exeFile.FullName)" `
  --content-type "application/vnd.microsoft.portable-executable" `
  --cache-control "public, max-age=31536000, immutable" `
  --remote
if ($LASTEXITCODE -ne 0) { throw "Falha ao enviar instalador .exe para o R2." }

npx --yes wrangler r2 object put "$BucketName/$r2ReleasePrefix/$($sigFile.Name)" `
  --file "$($sigFile.FullName)" `
  --content-type "text/plain; charset=utf-8" `
  --cache-control "public, max-age=31536000, immutable" `
  --remote
if ($LASTEXITCODE -ne 0) { throw "Falha ao enviar assinatura .sig para o R2." }

npx --yes wrangler r2 object put "$BucketName/latest.json" `
  --file "$latestJsonPath" `
  --content-type "application/json; charset=utf-8" `
  --cache-control "public, max-age=60" `
  --remote
if ($LASTEXITCODE -ne 0) { throw "Falha ao enviar latest.json para o R2." }

Write-Host ""
Write-Host "==> Release v$Version publicado com sucesso no Cloudflare R2!" -ForegroundColor Green
Write-Host "    Manifesto : $baseUrl/latest.json" -ForegroundColor Cyan
Write-Host "    Download  : $downloadUrl" -ForegroundColor Cyan
