#!/usr/bin/env bash
# ========================================================
# Food Delivery System - Linux/macOS Startup Script
#   ./start-all.sh            -> Docker (real PostgreSQL + Redis + RabbitMQ, one container per service)
#   ./start-all.sh --local    -> single Node process, in-memory stores (development only, no Docker)
# ========================================================
echo "================================================================"
echo "  Food Delivery Order and Kitchen Management System Launcher"
echo "================================================================"

if [ "$1" != "--local" ]; then
    echo "Starting the full stack via Docker Compose..."
    docker compose up --build -d
    echo "Check status with: docker compose ps"
    echo "• Frontend:   http://localhost:3000  (or http://localhost:8080/app)"
    echo "• Gateway:    http://localhost:8080"
    echo "• Health:     http://localhost:8080/health"
    echo "• RabbitMQ:   http://localhost:15672 (guest/guest)"
    exit 0
fi

echo "Local mode: ONE Node process with in-memory stores (not the real infrastructure)."
[ -d node_modules ] || npm install
ALLOW_IN_MEMORY_FALLBACK=true node server.js
