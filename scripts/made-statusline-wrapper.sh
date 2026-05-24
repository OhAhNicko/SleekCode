#!/bin/bash
# MADE statusline wrapper — extracts context window data for pane headers,
# then chains to the user's original statusline script (e.g. cc-statusline).
#
# Installed to ~/.made/statusline-wrapper.sh by MADE.
# Requires: jq, MADE_TID env var (set by MADE when spawning CLI panes).

input=$(cat)

# Extract context window data for MADE pane header
if [ -n "$MADE_TID" ] && command -v jq >/dev/null 2>&1; then
  _cs=$(echo "$input" | jq -r '.context_window.context_window_size // 200000' 2>/dev/null)
  _usage=$(echo "$input" | jq '.context_window.current_usage' 2>/dev/null)
  if [ "$_usage" != "null" ] && [ -n "$_usage" ]; then
    _tok=$(echo "$_usage" | jq '(.input_tokens // 0) + (.cache_creation_input_tokens // 0) + (.cache_read_input_tokens // 0)' 2>/dev/null)
    if [ -n "$_tok" ] && [ "$_tok" -gt 0 ] 2>/dev/null; then
      _pct=$((100 - _tok * 100 / _cs))
      ((_pct < 0)) && _pct=0; ((_pct > 100)) && _pct=100
      echo "$_pct" > "/tmp/made-context-$MADE_TID"
    fi
  fi
fi

# Chain to original statusline script, or pass through unchanged
_chain="$(cat "$HOME/.made/statusline-chain" 2>/dev/null)"
# Guard: never chain to ourselves (prevents infinite recursion / fork bomb)
case "$_chain" in *statusline-wrapper*) _chain="" ;; esac
if [ -n "$_chain" ] && [ -x "$_chain" ]; then
  echo "$input" | "$_chain"
else
  echo "$input"
fi
