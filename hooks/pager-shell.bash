# Pager — best-effort: echo command before run so pipe-pane logs see it.
# Bash has no preexec; DEBUG can fire for nested commands (noisier than zsh).
# Prefer: hooks/pager-shell.zsh
#
# Install: add to ~/.bashrc (interactive only)
#   [[ $- == *i* ]] && source /path/to/pager/hooks/pager-shell.bash

[[ $- == *i* ]] || return 0
[[ -z "${PAGER_BASH_HOOK_LOADED:-}" ]] || return 0
PAGER_BASH_HOOK_LOADED=1

_pager_dbg() {
  local c=${BASH_COMMAND-}
  case "$c" in
    _pager_dbg|trap\ *) return ;;
  esac
  builtin printf '%s\n[pager] cwd: %s\n' "[pager] cmd: $c" "$PWD"
}
trap '_pager_dbg' DEBUG
