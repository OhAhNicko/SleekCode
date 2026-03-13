#!/usr/bin/env bash
# Launches Tauri dev. On WSL, delegates to Windows PowerShell.
# On macOS/Linux, runs directly.

set -e

# Detect platform
if grep -qi microsoft /proc/version 2>/dev/null; then
  # WSL → delegate to Windows PowerShell
  WIN_DIR=$(wslpath -w "$(pwd)")

  echo "[EzyDev] Launching Tauri dev via Windows PowerShell..."
  echo "[EzyDev] Project: $WIN_DIR"
  echo ""

  powershell.exe -NoProfile -Command "
    \$env:Path = \"\$env:USERPROFILE\\.cargo\\bin;\" + \$env:Path
    Set-Location '$WIN_DIR'

    # Kill any stale node on our dev port before starting
    \$port = 5420
    Get-NetTCPConnection -LocalPort \$port -ErrorAction SilentlyContinue |
      Where-Object { \$_.OwningProcess -ne 0 } |
      ForEach-Object {
        try { Stop-Process -Id \$_.OwningProcess -Force -ErrorAction Stop }
        catch { Write-Host \"[EzyDev] Could not kill PID \$(\$_.OwningProcess) - may need admin rights\" }
      }

    npm install --prefer-offline
    npx tauri dev
  "
else
  # macOS / Linux → run directly
  echo "[EzyDev] Launching Tauri dev..."
  echo "[EzyDev] Project: $(pwd)"
  echo ""

  # Kill any stale node on our dev port
  lsof -ti:5420 2>/dev/null | xargs kill -9 2>/dev/null || true

  npm install --prefer-offline
  npx tauri dev
fi
