#!/usr/bin/env bash
# Builds Tauri production binary. On WSL, delegates to Windows PowerShell.
# On macOS/Linux, runs directly.

set -e

if grep -qi microsoft /proc/version 2>/dev/null; then
  # WSL → delegate to Windows PowerShell
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
else
  # macOS / Linux → build directly
  echo "[EzyDev] Building Tauri production binary..."
  echo "[EzyDev] Project: $(pwd)"
  echo ""

  npm install
  npx tauri build
fi
