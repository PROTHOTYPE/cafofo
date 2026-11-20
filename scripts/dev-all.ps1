<#
.SYNOPSIS
  Inicia toda a stack de desenvolvimento do Cafofo na ordem correta:
  1. LiveKit Server local (--dev --bind 0.0.0.0, porta 7880 / WebRTC)
  2. Servidor Axum de sinalizacao (0.0.0.0:3001)
  3. Frontend Vite + Desktop Tauri (porta 1420) ou apenas Vite web (-WebOnly)

  Aguarda ativamente (polling TCP) as portas 7880 e 3001 entrarem em estado
  Listen antes de abrir o cliente para evitar falhas de conexao no arranque.

.EXAMPLE
  pnpm dev:all
  powershell -File scripts/dev-all.ps1 -WebOnly
#>
param(
  [switch]$WebOnly
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

$CargoBinDir = Join-Path $env:USERPROFILE ".cargo\bin"
if ((Test-Path $CargoBinDir) -and ($env:PATH -notlike "*$CargoBinDir*")) {
  $env:PATH = "$CargoBinDir;$env:PATH"
}

function Test-PortListening {
  param(
    [int]$Port
  )
  try {
    $listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    if ($listening) {
      return $true
    }
  } catch {
    # Fallback para TcpClient caso Get-NetTCPConnection nao esteja disponivel
  }

  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $asyncResult = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
    if ($asyncResult.AsyncWaitHandle.WaitOne(250, $false)) {
      $client.EndConnect($asyncResult)
      return $true
    }
    return $false
  } catch {
    return $false
  } finally {
    $client.Dispose()
  }
}

function Wait-ForPort {
  param(
    [string]$ServiceName,
    [int]$Port,
    [System.Diagnostics.Process]$Process,
    [string[]]$LogPaths = @(),
    [int]$TimeoutSeconds = 60
  )

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    if ($Process -and $Process.HasExited) {
      foreach ($logPath in $LogPaths) {
        if ($logPath -and (Test-Path $logPath)) {
          $content = Get-Content $logPath -Tail 30 -ErrorAction SilentlyContinue
          if ($content) {
            Write-Host "--- Log ($logPath) ---" -ForegroundColor DarkGray
            $content | ForEach-Object { Write-Host $_ -ForegroundColor Gray }
          }
        }
      }
      throw "$ServiceName encerrou inesperadamente (codigo $($Process.ExitCode)) antes de abrir a porta $Port."
    }
    if (Test-PortListening -Port $Port) {
      Write-Host "   [OK] $ServiceName escutando na porta $Port" -ForegroundColor Green
      return
    }
    Start-Sleep -Milliseconds 500
  }

  throw "Timeout aguardando $ServiceName abrir a porta $Port apos ${TimeoutSeconds}s."
}

$LiveKitExe = Join-Path $RepoRoot ".tools\livekit\livekit-server.exe"
if (-not (Test-Path $LiveKitExe)) {
  Write-Error "LiveKit nao encontrado em $LiveKitExe. Execute scripts/setup-livekit.ps1 primeiro."
  exit 1
}

$LogsDir = Join-Path $RepoRoot ".tools\logs"
New-Item -ItemType Directory -Force -Path $LogsDir | Out-Null
$LiveKitOutLog = Join-Path $LogsDir "livekit.out.log"
$LiveKitErrLog = Join-Path $LogsDir "livekit.err.log"
$ServerOutLog = Join-Path $LogsDir "server.out.log"
$ServerErrLog = Join-Path $LogsDir "server.err.log"

if (Get-Command pnpm -ErrorAction SilentlyContinue) {
  $PnpmCmd = "pnpm"
  $PnpmPrefixArgs = @()
} else {
  $PnpmCmd = "corepack"
  $PnpmPrefixArgs = @("pnpm")
}

Write-Host "============================================================" -ForegroundColor DarkGray
Write-Host " Cafofo Dev Orchestrator (Ordem: LiveKit -> Axum -> Client)" -ForegroundColor Red
Write-Host "============================================================" -ForegroundColor DarkGray

$LiveKitProc = $null
$ServerProc = $null

try {
  if (Test-PortListening -Port 7880) {
    Write-Host " [1/3] LiveKit ja esta escutando na porta 7880." -ForegroundColor DarkYellow
  } else {
    Write-Host " [1/3] Subindo LiveKit SFU em 0.0.0.0:7880..." -ForegroundColor Cyan
    $LiveKitProc = Start-Process -FilePath $LiveKitExe `
      -ArgumentList "--dev", "--bind", "0.0.0.0" `
      -WorkingDirectory $RepoRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput $LiveKitOutLog `
      -RedirectStandardError $LiveKitErrLog `
      -PassThru
    Wait-ForPort -ServiceName "LiveKit SFU" -Port 7880 -Process $LiveKitProc -LogPaths @($LiveKitOutLog, $LiveKitErrLog) -TimeoutSeconds 45
  }

  if (Test-PortListening -Port 3001) {
    Write-Host " [2/3] Servidor Axum (cafofo-server) ja esta escutando na porta 3001." -ForegroundColor DarkYellow
  } else {
    Write-Host " [2/3] Compilando e subindo Servidor Axum (cafofo-server) em 0.0.0.0:3001..." -ForegroundColor Cyan

    $CargoCmd = Get-Command cargo -ErrorAction SilentlyContinue
    if (-not $CargoCmd) {
      throw "Cargo nao encontrado no PATH nem em $CargoBinDir."
    }

    & $CargoCmd.Source build -p cafofo-server
    if ($LASTEXITCODE -ne 0) {
      throw "Falha ao compilar cafofo-server (codigo $LASTEXITCODE)."
    }

    $ServerExe = Join-Path $RepoRoot "target\debug\cafofo-server.exe"
    if (-not (Test-Path $ServerExe)) {
      throw "Binario nao encontrado em $ServerExe apos o build."
    }

    $ServerProc = Start-Process -FilePath $ServerExe `
      -WorkingDirectory (Join-Path $RepoRoot "apps\server") `
      -WindowStyle Hidden `
      -RedirectStandardOutput $ServerOutLog `
      -RedirectStandardError $ServerErrLog `
      -PassThru
    Wait-ForPort -ServiceName "Cafofo Signaling Server" -Port 3001 -Process $ServerProc -LogPaths @($ServerOutLog, $ServerErrLog) -TimeoutSeconds 45
    $ServerBanner = Get-Content $ServerOutLog -TotalCount 1 -ErrorAction SilentlyContinue
    if ($ServerBanner) {
      Write-Host "   $ServerBanner" -ForegroundColor Gray
    }
  }

  $lanIps = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" } |
    Select-Object -ExpandProperty IPAddress -Unique

  if ($lanIps) {
    Write-Host ""
    Write-Host " URLs para acesso em Rede Local (LAN / Celular):" -ForegroundColor Green
    foreach ($ip in $lanIps) {
      Write-Host "   -> http://${ip}:1420" -ForegroundColor White
    }
    Write-Host ""
  }

  Write-Host " Logs em segundo plano: .tools\logs\{livekit,server}.{out,err}.log" -ForegroundColor DarkGray

  if ($WebOnly) {
    Write-Host " [3/3] Subindo Vite Web Dev Server (0.0.0.0:1420)..." -ForegroundColor Cyan
    & $PnpmCmd @($PnpmPrefixArgs + @("dev:web"))
  } else {
    Write-Host " [3/3] Subindo Cafofo Desktop (Vite :1420 + Tauri)..." -ForegroundColor Cyan
    & $PnpmCmd @($PnpmPrefixArgs + @("dev:desktop"))
  }
}
finally {
  Write-Host ""
  Write-Host "Encerrando processos em segundo plano iniciados por este script..." -ForegroundColor Yellow
  if ($ServerProc -and -not $ServerProc.HasExited) {
    Stop-Process -Id $ServerProc.Id -Force -ErrorAction SilentlyContinue
  }
  if ($LiveKitProc -and -not $LiveKitProc.HasExited) {
    Stop-Process -Id $LiveKitProc.Id -Force -ErrorAction SilentlyContinue
  }
}
