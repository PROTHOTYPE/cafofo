<#
.SYNOPSIS
  Deploy automatizado em nuvem do Cafofo:
  1. Servidor Rust Axum (cafofo-server) no Fly.io regiao gru (Sao Paulo) com build remoto
  2. Frontend Web/Mobile Vite (@cafofo/desktop) no Cloudflare Pages HTTPS com SPA _redirects
#>
[CmdletBinding()]
param(
  [string]$EnvFile = ".env.production",
  [string]$FlyAppName = "",
  [string]$PagesProjectName = "cafofo",
  [switch]$PagesOnly
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Resolve-Flyctl {
  $candidates = @(
    "flyctl",
    "fly",
    (Join-Path $env:USERPROFILE ".fly\bin\flyctl.exe"),
    (Join-Path $env:USERPROFILE ".fly\bin\fly.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Links\flyctl.exe")
  )
  foreach ($cand in $candidates) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    if ((Test-Path $cand)) { return $cand }
  }

  $wingetPkgDir = Join-Path $env:LOCALAPPDATA "Microsoft\WinGet\Packages"
  if (Test-Path $wingetPkgDir) {
    $found = Get-ChildItem -Path $wingetPkgDir -Filter "flyctl.exe" -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) { return $found.FullName }
  }
  return $null
}

function Ensure-Flyctl {
  $exe = Resolve-Flyctl
  if ($exe) { return $exe }

  Write-Step "Instalando flyctl via winget..."
  $installed = $false
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    foreach ($pkgId in @("Fly-io.flyctl", "Fly.flyctl")) {
      & winget install --id $pkgId -e --accept-source-agreements --accept-package-agreements 2>&1 | Out-Host
      if ($LASTEXITCODE -eq 0) {
        $installed = $true
        break
      }
    }
  }

  if (-not $installed) {
    Write-Step "Tentando instalador oficial do Fly.io..."
    $installCode = Invoke-RestMethod -Uri "https://fly.io/install.ps1"
    Invoke-Expression $installCode 2>&1 | Out-Host
  }

  $env:PATH = "$env:USERPROFILE\.fly\bin;$env:LOCALAPPDATA\Microsoft\WinGet\Links;$env:PATH"
  $exe = Resolve-Flyctl
  if (-not $exe) {
    throw "Nao foi possivel localizar flyctl apos a instalacao. Reinicie o terminal ou instale manualmente em https://fly.io/docs/flyctl/install/."
  }
  return $exe
}

function Read-DotEnvFile {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    throw "Arquivo $Path nao encontrado."
  }
  $map = @{}
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if (-not $line -or $line.StartsWith("#")) { return }
    if ($line -match '^([^=]+)=(.*)$') {
      $key = $matches[1].Trim()
      $val = $matches[2].Trim()
      if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
        $val = $val.Substring(1, $val.Length - 2)
      }
      $map[$key] = $val
    }
  }
  return $map
}

function Invoke-Fly {
  param(
    [string]$FlyExe,
    [string[]]$Arguments
  )
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $FlyExe @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  $lines = foreach ($item in $output) {
    if ($item -is [System.Management.Automation.ErrorRecord]) { $item.ToString() } else { "$item" }
  }
  return @{
    ExitCode = $code
    Lines    = $lines
    Text     = ($lines -join [Environment]::NewLine)
  }
}

function Invoke-CommandCaptured {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $output = & $FilePath @Arguments 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  $lines = foreach ($item in $output) {
    if ($item -is [System.Management.Automation.ErrorRecord]) { $item.ToString() } else { "$item" }
  }
  return @{
    ExitCode = $code
    Lines    = $lines
    Text     = ($lines -join [Environment]::NewLine)
  }
}

# 1. Carregar .env.production
Write-Step "Carregando variaveis de ambiente de $EnvFile..."
$envPath = if ([System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path $RepoRoot $EnvFile }
$prodEnv = Read-DotEnvFile -Path $envPath

$requiredKeys = @(
  "SUPABASE_URL",
  "SUPABASE_PUBLISHABLE_KEY",
  "VITE_SUPABASE_URL",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET"
)
foreach ($req in $requiredKeys) {
  if ([string]::IsNullOrWhiteSpace($prodEnv[$req])) {
    throw "Variavel obrigatoria '$req' ausente ou vazia em $EnvFile."
  }
}

$secretKey = $prodEnv["SUPABASE_SECRET_KEY"]
if ([string]::IsNullOrWhiteSpace($secretKey)) {
  $secretKey = $prodEnv["SUPABASE_SERVICE_ROLE_KEY"]
}
if ([string]::IsNullOrWhiteSpace($secretKey)) {
  throw "SUPABASE_SECRET_KEY ou SUPABASE_SERVICE_ROLE_KEY obrigatoria em $EnvFile."
}

# 2. Verificar flyctl e autenticacao
$FlyExe = Ensure-Flyctl
Write-Host "   flyctl: $FlyExe" -ForegroundColor Green

# 3. Ler/selecionar ou criar app no Fly.io
$flyTomlPath = Join-Path $RepoRoot "fly.toml"
if ([string]::IsNullOrWhiteSpace($FlyAppName) -and (Test-Path $flyTomlPath)) {
  $tomlContent = Get-Content $flyTomlPath -Raw
  if ($tomlContent -match '(?m)^app\s*=\s*"([^"]+)"') {
    $FlyAppName = $matches[1].Trim()
  }
}
if ([string]::IsNullOrWhiteSpace($FlyAppName)) {
  $FlyAppName = "cafofo-signaling"
}

if (-not $PagesOnly) {
  $whoFly = Invoke-Fly -FlyExe $FlyExe -Arguments @("auth", "whoami")
  if ($whoFly.ExitCode -ne 0) {
    Write-Step "Autenticando no Fly.io (abrindo navegador)..."
    & $FlyExe auth login
    if ($LASTEXITCODE -ne 0) {
      throw "Falha ao autenticar no Fly.io."
    }
    $whoFly = Invoke-Fly -FlyExe $FlyExe -Arguments @("auth", "whoami")
  }
  Write-Host "   Conta Fly.io: $($whoFly.Text.Trim())" -ForegroundColor Green

  Write-Step "Verificando app '$FlyAppName' no Fly.io..."
  $statusCheck = Invoke-Fly -FlyExe $FlyExe -Arguments @("status", "--app", $FlyAppName, "--json")
  if ($statusCheck.ExitCode -ne 0) {
    Write-Host "   App '$FlyAppName' ainda nao existe na sua conta. Criando..." -ForegroundColor Yellow
    $createRes = Invoke-Fly -FlyExe $FlyExe -Arguments @("apps", "create", $FlyAppName, "--org", "personal")
    if ($createRes.ExitCode -ne 0) {
      $suffix = ([guid]::NewGuid().ToString("N")).Substring(0, 6)
      $FlyAppName = "$FlyAppName-$suffix"
      Write-Host "   Nome reservado globalmente; criando app '$FlyAppName'..." -ForegroundColor Yellow
      $createRes2 = Invoke-Fly -FlyExe $FlyExe -Arguments @("apps", "create", $FlyAppName, "--org", "personal")
      if ($createRes2.ExitCode -ne 0) {
        throw "Falha ao criar app no Fly.io:`n$($createRes2.Text)"
      }
    }

    if (Test-Path $flyTomlPath) {
      $updatedToml = (Get-Content $flyTomlPath -Raw) -replace '(?m)^\uFEFF?app\s*=\s*"[^"]+"', "app = `"$FlyAppName`""
      [System.IO.File]::WriteAllText($flyTomlPath, $updatedToml, (New-Object System.Text.UTF8Encoding $false))
    }
  }

  # 4. Injetar secrets no Fly.io
  Write-Step "Configurando secrets de producao no app '$FlyAppName'..."
  $secretArgs = @(
    "secrets", "set",
    "--app", $FlyAppName,
    "--stage",
    "SUPABASE_URL=$($prodEnv['SUPABASE_URL'])",
    "SUPABASE_PUBLISHABLE_KEY=$($prodEnv['SUPABASE_PUBLISHABLE_KEY'])",
    "SUPABASE_SECRET_KEY=$secretKey",
    "SUPABASE_SERVICE_ROLE_KEY=$secretKey",
    "LIVEKIT_URL=$($prodEnv['LIVEKIT_URL'])",
    "LIVEKIT_API_KEY=$($prodEnv['LIVEKIT_API_KEY'])",
    "LIVEKIT_API_SECRET=$($prodEnv['LIVEKIT_API_SECRET'])",
    "CAFOFO_HOST=0.0.0.0",
    "CAFOFO_PORT=3001",
    "CAFOFO_GRACE_PERIOD_MS=15000"
  )
  & $FlyExe @secretArgs
  if ($LASTEXITCODE -ne 0) {
    throw "Falha ao definir secrets no Fly.io."
  }

  # 5. Deploy remoto do servidor Rust Axum
  Write-Step "Executando build & deploy remoto no Fly.io (regiao gru - Sao Paulo)..."
  & $FlyExe deploy --app $FlyAppName --config $flyTomlPath --remote-only --yes
  if ($LASTEXITCODE -ne 0) {
    throw "Falha no fly deploy."
  }
}

# 6. Obter URL HTTPS/WSS real do app no Fly.io
$flyHost = "$FlyAppName.fly.dev"
$statusAfter = Invoke-Fly -FlyExe $FlyExe -Arguments @("status", "--app", $FlyAppName, "--json")
if ($statusAfter.ExitCode -eq 0) {
  try {
    $parsed = $statusAfter.Text | ConvertFrom-Json
    if ($parsed.Hostname) { $flyHost = [string]$parsed.Hostname }
  } catch {
    # mantem fallback <app>.fly.dev
  }
}

$flyHttpsUrl = "https://$flyHost"
$signalingWssUrl = "wss://$flyHost/ws"
Write-Host "   Servidor Axum publicado: $flyHttpsUrl" -ForegroundColor Green
Write-Host "   Endpoint WebSocket:      $signalingWssUrl" -ForegroundColor Green

try {
  $healthRes = Invoke-RestMethod -Uri "$flyHttpsUrl/health" -TimeoutSec 15
  Write-Host "   Health Check OK:         status=$($healthRes.status), livekit=$($healthRes.livekit_url)" -ForegroundColor Green
} catch {
  Write-Host "   Aviso: /health ainda aquecendo ($($_.Exception.Message))" -ForegroundColor Yellow
}

# 7. Build de producao do frontend com variaveis apontando para o Fly.io + Supabase
Write-Step "Gerando build de producao do frontend (@cafofo/desktop)..."
$env:VITE_SIGNALING_URL = $signalingWssUrl
$env:VITE_SUPABASE_URL = $prodEnv["VITE_SUPABASE_URL"]
$env:VITE_SUPABASE_PUBLISHABLE_KEY = $prodEnv["VITE_SUPABASE_PUBLISHABLE_KEY"]

$pnpmCmd = if (Get-Command pnpm -ErrorAction SilentlyContinue) { "pnpm" } else { "corepack" }
$pnpmPrefix = if ($pnpmCmd -eq "corepack") { @("pnpm") } else { @() }

& $pnpmCmd @pnpmPrefix --filter @cafofo/core-logic build
if ($LASTEXITCODE -ne 0) { throw "Falha ao compilar @cafofo/core-logic." }

& $pnpmCmd @pnpmPrefix --filter @cafofo/desktop build
if ($LASTEXITCODE -ne 0) { throw "Falha ao compilar @cafofo/desktop." }

$distDir = Join-Path $RepoRoot "apps\desktop\dist"
if (-not (Test-Path $distDir)) {
  throw "Diretorio de build $distDir nao encontrado."
}

# 8. Verificar autenticacao Cloudflare Wrangler e publicar no Cloudflare Pages
Write-Step "Verificando autenticacao no Cloudflare Wrangler..."
$npxExe = (Get-Command npx -ErrorAction Stop).Source
$whoWrangler = Invoke-CommandCaptured -FilePath $npxExe -Arguments @("--yes", "wrangler", "whoami")
if ($whoWrangler.ExitCode -ne 0 -or $whoWrangler.Text -match "not authenticated") {
  Write-Step "Autenticando no Cloudflare Pages via Wrangler (abrindo navegador)..."
  & $npxExe --yes wrangler login
  if ($LASTEXITCODE -ne 0) {
    throw "Falha ao autenticar no Cloudflare."
  }
}

Write-Step "Garantindo projeto '$PagesProjectName' no Cloudflare Pages..."
$createProjectRes = Invoke-CommandCaptured -FilePath $npxExe -Arguments @(
  "--yes", "wrangler", "pages", "project", "create", $PagesProjectName, "--production-branch=main", "--force"
)
if ($createProjectRes.ExitCode -ne 0 -and $createProjectRes.Text -notmatch "already exists|8000002") {
  Write-Host $createProjectRes.Text -ForegroundColor DarkYellow
}

Write-Step "Publicando apps/desktop/dist no Cloudflare Pages..."
$deployPagesRes = Invoke-CommandCaptured -FilePath $npxExe -Arguments @(
  "--yes", "wrangler", "pages", "deploy", "apps/desktop/dist", "--project-name=$PagesProjectName", "--branch=main"
)
$deployPagesRes.Lines | ForEach-Object { Write-Host $_ }
if ($deployPagesRes.ExitCode -ne 0) {
  throw "Falha ao publicar no Cloudflare Pages."
}

$pagesUrl = "https://$PagesProjectName.pages.dev"
if ($deployPagesRes.Text -match '(https://[a-zA-Z0-9.-]+\.pages\.dev)') {
  $pagesUrl = $matches[1]
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host " CAFOFO DEPLOY CONCLUIDO COM SUCESSO" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host " Signaling Server (Fly.io): $signalingWssUrl" -ForegroundColor Cyan
Write-Host " LiveKit Cloud SFU:         $($prodEnv['LIVEKIT_URL'])" -ForegroundColor Cyan
Write-Host " Web / Mobile HTTPS:        $pagesUrl" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor DarkGray
