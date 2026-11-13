# ========================================================
# Food Delivery System - Windows Test Execution Script
# Prerequisite: the stack is running  ->  docker compose up --build -d
# ========================================================
if (-not (Test-Path node_modules)) { npm install }

function Wait-Gateway {
    for ($i = 0; $i -lt 60; $i++) {
        try { Invoke-WebRequest -UseBasicParsing http://localhost:8080/ | Out-Null; return } catch { Start-Sleep -Seconds 1 }
    }
    throw "Gateway did not come up"
}

Write-Host "1. Running integration tests (real HTTP + real PostgreSQL)..." -ForegroundColor Cyan
node tests/run-tests.js
if ($LASTEXITCODE -ne 0) {
    Write-Host "Tests failed! Aborting load tests." -ForegroundColor Red
    exit 1
}

Write-Host "`n2. Restarting the gateway with TRUST_PROXY=true so virtual users can use distinct client IPs..." -ForegroundColor Cyan
$env:TRUST_PROXY = "true"
docker compose up -d api-gateway
Wait-Gateway

Write-Host "`n3. Running load tests..." -ForegroundColor Cyan
node load-tests/runner.js
$loadExit = $LASTEXITCODE

Write-Host "`n4. Restoring the gateway to its normal (secure) setting..." -ForegroundColor Cyan
Remove-Item Env:TRUST_PROXY
docker compose up -d api-gateway
if ($loadExit -ne 0) { exit 1 }

Write-Host "`nDone. Regenerate the PDF report with: npm run generate-docs" -ForegroundColor Green
