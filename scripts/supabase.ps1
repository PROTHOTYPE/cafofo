[CmdletBinding(PositionalBinding = $false)]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$CliArgs
)

$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "lib\supabase-common.ps1")

$RepoRoot = Get-CafofoRepoRoot
Import-CafofoEnv -RepoRoot $RepoRoot
$SupabaseExe = Ensure-SupabaseCli -RepoRoot $RepoRoot

Push-Location $RepoRoot
try {
    $ErrorActionPreference = "Continue"
    & $SupabaseExe @CliArgs
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
