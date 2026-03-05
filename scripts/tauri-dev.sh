#!/usr/bin/env bash
# Launches Tauri dev from WSL by delegating to Windows PowerShell.
# Tauri needs Windows-native cargo (MSVC target) and Windows npm shims,
# so we can't run it directly from WSL.

set -e

WIN_DIR=$(wslpath -w "$(pwd)")

echo "[EzyDev] Launching Tauri dev via Windows PowerShell..."
echo "[EzyDev] Project: $WIN_DIR"
echo ""

# Use cmd.exe /c so child processes are in the same job object
# and get killed when the parent terminates
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
