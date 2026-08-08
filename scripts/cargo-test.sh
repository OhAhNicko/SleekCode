#!/usr/bin/env bash
# Runs the Rust unit tests. On WSL, delegates to Windows PowerShell.
# On macOS/Linux, runs directly.
#
# MADE compiles as a native Windows app with the MSVC toolchain, so WSL's cargo
# builds none of the win32 code. Every Rust build has to cross the boundary the
# same way scripts/tauri-dev.sh does.
#
# WHY THIS IS NOT JUST `cargo test` (2026-08-06): the test harness is a plain
# executable with no application manifest, so Windows binds it to the legacy
# comctl32 v5.82 in System32. The crate imports `TaskDialogIndirect`,
# `SetWindowSubclass` and `DefSubclassProc`, which only exist in Common Controls
# v6 — so the binary failed to LOAD, exiting 0xc0000139
# (STATUS_ENTRYPOINT_NOT_FOUND) before a single test ran. `made.exe` itself is
# fine because tauri-build attaches a manifest via `cargo:rustc-link-arg-bins`,
# which by design does not apply to test targets.
#
# So we build and run in two steps and stamp a Common-Controls-6 manifest into
# the freshly linked test binary with mt.exe in between. An external
# `<exe>.manifest` does NOT work: modern Windows ignores those unless
# HKLM\...\SideBySide\PreferExternalManifest is set, and changing a machine-wide
# registry key to run a test suite is not a trade worth making.
#
# The first run after a dependency change is multi-minute (wgpu, alacritty,
# bundled SQLite) — that is a cold compile, not a hang.
#
# Usage: bash scripts/cargo-test.sh [filter]
#   npm run test:rust                 # everything
#   npm run test:rust -- knowledge    # just the knowledge module

set -e

FILTER="${1:-}"

if grep -qi microsoft /proc/version 2>/dev/null; then
  # WSL → delegate to Windows PowerShell
  WIN_DIR=$(wslpath -w "$(pwd)/src-tauri")

  echo "[MADE] Running cargo test via Windows PowerShell..."
  echo "[MADE] Crate: $WIN_DIR"
  [ -n "$FILTER" ] && echo "[MADE] Filter: $FILTER"
  echo ""

  # The body goes to a temp .ps1 and runs with -File, NOT piped to
  # `powershell -Command -`.
  #
  # Piping worked while the body was one straight-line sequence, but once it
  # grew a `foreach` over the two test executables PowerShell silently stopped
  # after the build: no tests ran, no error, and the script still exited 0 — a
  # green `npm run test:rust` that had verified NOTHING. A file is parsed as one
  # unit and cannot truncate that way, which is worth more here than saving a
  # temp file, because the failure mode of the pipe is a false pass.
  PS_TMP_WIN=$(powershell.exe -NoProfile -Command 'Write-Output $env:TEMP' | tr -d '\r')
  PS_TMP_DIR=$(wslpath -u "$PS_TMP_WIN")
  PS_SCRIPT="$PS_TMP_DIR/made-cargo-test-$$.ps1"
  trap 'rm -f "$PS_SCRIPT"' EXIT

  # The two interpolated values are emitted as PowerShell assignments so the
  # script body below can stay in a fully quoted heredoc — no nested escaping.
  {
    echo "\$WinDir = '$WIN_DIR'"
    echo "\$Filter = '$FILTER'"
    cat <<'PSEOF'
$env:Path = "$env:USERPROFILE\.cargo\bin;" + $env:Path
Set-Location $WinDir

# Build without running so there is a moment to stamp the manifest. Diagnostics
# render to stderr and reach the terminal; stdout stays machine-readable.
# --bin made-knowledge-mcp brings the MCP adapter's own unit tests into the
# gate (deliberately NOT --bins: that would also link a pointless test harness
# for the `made` bin itself). Two test executables come out; stamp + run both.
$artifacts = cargo test --lib --bin made-knowledge-mcp --no-run --message-format=json-render-diagnostics
# A compile error in ONE harness must fail the run. Without this check, a lib
# that does not build while the bin still does yields a passing bin run and
# CARGO_EXIT=0 — a third false-green mode in this script's history (found
# 2026-08-07 when a deliberately-red lib test reported green).
if ($LASTEXITCODE -ne 0) {
  Write-Output "[MADE] cargo build failed - see the errors above"
  Write-Output ("CARGO_EXIT=" + $LASTEXITCODE)
  exit 1
}
$exes = @()
foreach ($line in $artifacts) {
  if ($line -notmatch '"executable"') { continue }
  try { $msg = $line | ConvertFrom-Json } catch { continue }
  if ($msg.executable) { $exes += $msg.executable }
}
if ($exes.Count -eq 0) {
  Write-Output "[MADE] no test executable was produced - see the errors above"
  Write-Output "CARGO_EXIT=1"
  exit 1
}

$manifest = Join-Path $env:TEMP "made-test.manifest"
@'
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<assembly xmlns="urn:schemas-microsoft-com:asm.v1" manifestVersion="1.0">
  <dependency>
    <dependentAssembly>
      <assemblyIdentity type="win32" name="Microsoft.Windows.Common-Controls" version="6.0.0.0" processorArchitecture="*" publicKeyToken="6595b64144ccf1df" language="*"/>
    </dependentAssembly>
  </dependency>
</assembly>
'@ | Set-Content -Path $manifest -Encoding UTF8

# Shallow scan of the SDK bin directories, newest first — a recursive search of
# Windows Kits takes minutes.
$mt = Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\bin" -Directory -ErrorAction SilentlyContinue |
      Sort-Object Name -Descending |
      ForEach-Object { Join-Path $_.FullName "x64\mt.exe" } |
      Where-Object { Test-Path $_ } |
      Select-Object -First 1
$worst = 0
foreach ($exe in $exes) {
  if ($mt) {
    # Stamping every harness is harmless; only the lib one imports comctl32 v6.
    & $mt -nologo -manifest $manifest -outputresource:"$($exe);1" | Out-Null
  } else {
    Write-Output "[MADE] mt.exe not found - the test binary will likely fail to load (0xc0000139)"
  }
  $testArgs = @("--nocapture")
  if ($Filter -ne "") { $testArgs += $Filter }
  & $exe @testArgs
  if ($LASTEXITCODE -eq -1073741511 -and $mt) {
    # 0xC0000139 STATUS_ENTRYPOINT_NOT_FOUND: the manifest stamp intermittently
    # doesn't take on the first run after a rebuild. Re-stamp and retry once —
    # observed repeatedly (2026-08-07); the second run always reports the truth.
    Write-Output "[MADE] entrypoint-not-found (stale manifest stamp) - re-stamping and retrying once"
    & $mt -nologo -manifest $manifest -outputresource:"$($exe);1" | Out-Null
    & $exe @testArgs
  }
  # -ne, not -gt: NTSTATUS failures are NEGATIVE (0xC0000139 = -1073741511), so
  # a greater-than test against 0 would report a loader failure as CARGO_EXIT=0
  # — the same false-pass class as the pipe truncation above. First nonzero wins.
  if ($LASTEXITCODE -ne 0 -and $worst -eq 0) { $worst = $LASTEXITCODE }
}
Write-Output ("CARGO_EXIT=" + $worst)
PSEOF
  } > "$PS_SCRIPT"
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$(wslpath -w "$PS_SCRIPT")"
else
  # macOS / Linux → run directly. No manifest dance: the comctl32 problem is
  # Windows-only, and so is the code that imports it.
  echo "[MADE] Running cargo test..."
  echo ""

  cd src-tauri
  cargo test --lib --bin made-knowledge-mcp -- --nocapture $FILTER
fi
