# Manual/Windows runner diagnostic - NO HTTP request unless -Probe is passed.
[CmdletBinding()]
param([switch]$Probe)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$script = Join-Path $PSScriptRoot "check_public_readiness.py"
if (-not (Get-Command python -ErrorAction SilentlyContinue)) { throw "Python 3 requerido" }
Push-Location $root
try {
    & python $script --self-test
    if ($LASTEXITCODE -ne 0) { throw "Readiness synthetic self-test FAILED" }
    & python -m unittest discover -s scripts/tests -p test_public_readiness_monitor.py -v
    if ($LASTEXITCODE -ne 0) { throw "Readiness unittest FAILED" }
    if ($Probe) {
        # ONLY exact public GET /api/v1/ready, no credentials or mutation.
        & python $script
        if ($LASTEXITCODE -ne 0) { throw "External readiness probe FAILED (investigate DNS/TLS/Cloudflare/API)" }
    }
    Write-Host "READINESS_LOCAL_TESTS_PASS - probe enabled: $Probe"
}
finally { Pop-Location }
