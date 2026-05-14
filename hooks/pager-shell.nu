# Pager — print each command line before it runs so tmux `pipe-pane` captures
# it in /tmp/pager-pane-*.log alongside stdout/stderr.
#
# Install: add to ~/.config/nushell/config.nu
#   source /Users/bhavya/Developer/side-projects/hakathons/pager/hooks/pager-shell.nu

$env.config.hooks.pre_execution = (
    ($env.config.hooks.pre_execution? | default [])
    | append {||
        let cmd = (commandline | str trim)
        if ($cmd | is-not-empty) {
            print $"[pager] cmd: ($cmd)"
            print $"[pager] cwd: ($env.PWD)"
        }
    }
)
