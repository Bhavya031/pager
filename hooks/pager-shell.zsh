# Pager — print each command line before it runs so tmux `pipe-pane` captures it
# in /tmp/pager-pane-*.log next to stderr/stdout.
#
# Install: add to ~/.zshrc
#   source /path/to/pager/hooks/pager-shell.zsh

emulate -L zsh 2>/dev/null || true

_pager_preexec() {
  print -r -- "[pager] cmd: $1"
  print -r -- "[pager] cwd: $PWD"
}

typeset -ga preexec_functions
preexec_functions+=(_pager_preexec)
