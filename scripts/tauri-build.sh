#!/usr/bin/env bash
# Builds Tauri production binary from WSL by delegating to Windows PowerShell.

set -e

WIN_DIR=$(wslpath -w "$(pwd)")

echo "[EzyDev] Building Tauri production binary via Windows PowerShell..."
echo "[EzyDev] Project: $WIN_DIR"
echo ""

powershell.exe -NoProfile -Command "
  \$env:Path = \"\$env:USERPROFILE\\.cargo\\bin;\" + \$env:Path
  Set-Location '$WIN_DIR'
  npm install
  npx tauri build
"
