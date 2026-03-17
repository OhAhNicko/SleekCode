/**
 * Shell integration script for OSC 133 command block marking.
 *
 * Emits sequences:
 *   OSC 133;A  → Prompt start
 *   OSC 133;B  → Prompt end / input start
 *   OSC 133;C  → Command execution start
 *   OSC 133;D;exitcode  → Command done
 *
 * Only injected into bash "shell" terminals, not AI agents.
 */

const SHELL_INTEGRATION_SCRIPT = `
# EzyDev shell integration — OSC 133 markers
__ezydev_last_exit=0
__ezydev_preexec_fired=0

__ezydev_prompt_cmd() {
  __ezydev_last_exit=$?
  __ezydev_preexec_fired=0
  printf '\\033]133;D;%s\\007' "$__ezydev_last_exit"
  printf '\\033]133;A\\007'
}

__ezydev_preexec() {
  [[ "$BASH_COMMAND" == __ezydev_* ]] && return
  [[ "$BASH_COMMAND" == "printf"* ]] && return
  if [[ "$__ezydev_preexec_fired" == "0" ]]; then
    __ezydev_preexec_fired=1
    printf '\\033]133;C\\007'
  fi
}

PROMPT_COMMAND="__ezydev_prompt_cmd\${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
PS1="\${PS1}\\[\\033]133;B\\007\\]"
trap '__ezydev_preexec' DEBUG
`.trim();

/**
 * Returns a command string that sources the integration script via eval,
 * then clears the screen so the user sees a clean prompt.
 */
export function getShellIntegrationCommand(): string {
  // Encode the script as a single eval line to avoid multi-line issues
  const escaped = SHELL_INTEGRATION_SCRIPT
    .replace(/\n/g, "; ")
    .replace(/;[\s;]+/g, "; ");
  return `eval '${escaped}'; clear\n`;
}

/**
 * Returns true if shell integration should be injected for this terminal type.
 * The integration script is bash-specific (PROMPT_COMMAND, trap DEBUG) —
 * it only works in bash, not PowerShell or zsh.
 * Currently shell type spawns PowerShell (WSL/Windows) or zsh (native),
 * so integration is disabled for all backends.
 */
export function shouldInjectShellIntegration(terminalType: string): boolean {
  // Shell integration uses bash-only features — never inject into non-bash shells.
  // The "shell" type spawns PowerShell (WSL/Windows) or zsh (native).
  void terminalType;
  return false;
}
