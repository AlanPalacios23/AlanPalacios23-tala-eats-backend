# TALA EATS BACKEND - QA aislado sobre Windows (sin GitHub Actions ni Kali)
# Uso: powershell -NoProfile -File scripts/qa-backend-windows.ps1 -InstallDependencies
[CmdletBinding()]
param(
    [switch]$InstallDependencies,
    [switch]$SkipFullTests
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$backend = Join-Path $repo "backend"
$requirements = Join-Path $backend "requirements-dev.txt"
if (-not (Test-Path $requirements)) { throw "No se encontro requirements-dev.txt" }
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    throw "Python no esta en PATH. Instala Python 3.13 y reintenta."
}
$venv = Join-Path $repo ".venv-backend-qa"
$qaPython = Join-Path $venv "Scripts\python.exe"
if (-not (Test-Path $qaPython)) {
    & python -m venv $venv
    if ($LASTEXITCODE -ne 0) { throw "No se pudo crear el entorno virtual aislado." }
}
$version = & $qaPython -c "import sys;print(f'{sys.version_info.major}.{sys.version_info.minor}')"
if ($LASTEXITCODE -ne 0) { throw "No se pudo verificar la version de Python." }
if ($version -ne "3.13") {
    Write-Warning "QA usa Python $version; CI productivo usa 3.13. No declara paridad completa."
}
if ($InstallDependencies) {
    & $qaPython -m pip install --disable-pip-version-check -r $requirements
    if ($LASTEXITCODE -ne 0) { throw "Fallo instalacion de dependencias de QA." }
}
$env:ENVIRONMENT = "development"
$env:DATABASE_URL = "sqlite://"
$env:REDIS_URL = ""
$env:JWT_SECRET = "ci-windows-disposable-secret-for-tests-only-more-than-40-bytes"
$env:SEED_DEMO_DATA = "true"
$env:STRIPE_ENABLED = "false"
$env:STRIPE_CONNECT_ENABLED = "false"
$env:STRIPE_CONNECT_SELF_SERVICE_ENABLED = "false"
$env:WITHDRAWALS_PREVIEW_ENABLED = "false"
$env:WITHDRAWALS_EXECUTION_ENABLED = "false"
$env:WITHDRAWALS_LIVE_ENABLED = "false"
$env:MERCADOPAGO_ACCESS_TOKEN = ""
$env:STRIPE_SECRET_KEY = ""
$env:STRIPE_WEBHOOK_SECRET = ""
$env:STRIPE_CONNECT_WEBHOOK_SECRET = ""
$env:REQUIRE_SMTP = "false"
$env:PYTHONDONTWRITEBYTECODE = "1"
$env:PYTHONPATH = $backend

Push-Location $repo
try {
    & $qaPython scripts/security_preflight.py --self-test
    if ($LASTEXITCODE -ne 0) { throw "Security preflight self-test FALLÓ" }
    & $qaPython scripts/security_preflight.py --root .
    if ($LASTEXITCODE -ne 0) { throw "Security preflight FALLÓ" }
    & $qaPython -m compileall -q backend/app backend/migrations backend/tests
    if ($LASTEXITCODE -ne 0) { throw "Compilacion sintactica FALLÓ" }

    Push-Location $backend
    try {
        & $qaPython tests/connect_security_smoke_v164h1.py
        if ($LASTEXITCODE -ne 0) { throw "Connect smoke FALLÓ" }
        & $qaPython -c "from alembic.config import Config; from alembic.script import ScriptDirectory; heads=ScriptDirectory.from_config(Config('alembic.ini')).get_heads(); assert len(heads)==1, heads; print('ALEMBIC_SINGLE_HEAD_PASS',heads[0])"
        if ($LASTEXITCODE -ne 0) { throw "Alembic head FALLÓ" }
        if (-not $SkipFullTests) {
            & $qaPython -m pytest -q --disable-warnings
            if ($LASTEXITCODE -ne 0) { throw "Suite pytest FALLÓ" }
        }
    }
    finally { Pop-Location }
    Write-Host "BACKEND_WINDOWS_ISOLATED_QA_PASS: no DB externa / no Stripe LIVE / no deploy"
}
finally { Pop-Location }
