# ========================================================
# Food Delivery System - Windows PowerShell Startup Script
#   .\start-all.ps1            -> Docker (real PostgreSQL + Redis + RabbitMQ, 1 container per service)
#   .\start-all.ps1 -Local     -> single Node process, in-memory stores (development only, no Docker)
# ========================================================
param (
    [switch]$Local
)

Write-Host "================================================================" -ForegroundColor Cyan
Write-Host "  Food Delivery Order and Kitchen Management System Launcher" -ForegroundColor Yellow
Write-Host "================================================================" -ForegroundColor Cyan

if (-not $Local) {
    Write-Host "Starting the full stack via Docker Compose..." -ForegroundColor Green
    docker compose up --build -d
    Write-Host "`nContainers started. Check status with: docker compose ps" -ForegroundColor Green
    Write-Host "  Frontend URL:            http://localhost:3000   (or http://localhost:8080/app)" -ForegroundColor White
    Write-Host "  API Gateway URL:         http://localhost:8080" -ForegroundColor White
    Write-Host "  Health Check Endpoint:   http://localhost:8080/health" -ForegroundColor White
    Write-Host "  RabbitMQ Management UI:  http://localhost:15672 (guest/guest)" -ForegroundColor White
    exit 0
}

Write-Host "Local mode: ONE Node process with in-memory stores (not the real infrastructure)." -ForegroundColor Yellow
if (-not (Test-Path node_modules)) { npm install }
$env:ALLOW_IN_MEMORY_FALLBACK = "true"
node server.js
