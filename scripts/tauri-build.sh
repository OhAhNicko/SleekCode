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

  # Forward signing env vars if set (for update bundle signing)
  SIGN_VARS=""
  if [ -n "$TAURI_SIGNING_PRIVATE_KEY" ]; then
    SIGN_VARS="\$env:TAURI_SIGNING_PRIVATE_KEY = '$TAURI_SIGNING_PRIVATE_KEY';"
    SIGN_VARS="$SIGN_VARS \$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = '${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}';"
  fi

  powershell.exe -NoProfile -Command "
    \$env:Path = \"\$env:USERPROFILE\\.cargo\\bin;\" + \$env:Path
    $SIGN_VARS
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
