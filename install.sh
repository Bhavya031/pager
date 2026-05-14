#!/usr/bin/env bash
#
# Pager installer.
#
#   curl -fsSL https://raw.githubusercontent.com/Bhavya031/pager/main/install.sh | bash
#
# Clones the repo to ~/.pager, installs deps, and puts `pager` on your PATH.
# Re-running it updates an existing install in place.

set -euo pipefail

REPO_URL="https://github.com/Bhavya031/pager.git"
INSTALL_DIR="${PAGER_INSTALL_DIR:-$HOME/.pager}"

blue=$'\033[34m'; green=$'\033[32m'; red=$'\033[31m'; dim=$'\033[2m'; off=$'\033[0m'
log()  { printf "%s[pager]%s %s\n" "$blue" "$off" "$*"; }
ok()   { printf "%s[pager]%s %s\n" "$green" "$off" "$*"; }
err()  { printf "%s[pager]%s %s\n" "$red" "$off" "$*" >&2; }
die()  { err "$*"; exit 1; }

# ── prerequisites ──────────────────────────────────────────────────────────

command -v git  >/dev/null 2>&1 || die "git not found — install git first."
command -v bun  >/dev/null 2>&1 || die "bun not found — install it: https://bun.sh"

# ── clone or update ────────────────────────────────────────────────────────

if [ -d "$INSTALL_DIR/.git" ]; then
  log "updating existing install at $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only
else
  log "cloning into $INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$INSTALL_DIR"
fi

# ── deps ───────────────────────────────────────────────────────────────────

log "installing dependencies"
( cd "$INSTALL_DIR" && bun install )

# ── put `pager` on PATH ────────────────────────────────────────────────────

chmod +x "$INSTALL_DIR/pager"
LINK_TARGET=""
for dir in /usr/local/bin "$HOME/.local/bin"; do
  if [ -d "$dir" ] && [ -w "$dir" ]; then
    LINK_TARGET="$dir/pager"
    break
  fi
done

if [ -n "$LINK_TARGET" ]; then
  ln -sf "$INSTALL_DIR/pager" "$LINK_TARGET"
  ok "linked $LINK_TARGET → $INSTALL_DIR/pager"
else
  err "couldn't find a writable bin dir on PATH."
  err "add this line to your shell rc yourself:"
  err "  alias pager='$INSTALL_DIR/pager'"
fi

# ── .env scaffold ──────────────────────────────────────────────────────────

if [ ! -f "$INSTALL_DIR/.env" ]; then
  cp "$INSTALL_DIR/.env.example" "$INSTALL_DIR/.env"
  log "created $INSTALL_DIR/.env — fill in your ElevenLabs keys before first run"
fi

# ── done ───────────────────────────────────────────────────────────────────

ok "installed."
printf "\n"
printf "%sNext:%s\n" "$green" "$off"
printf "  1. edit %s%s/.env%s — set ELEVENLABS_AGENT_ID and ELEVENLABS_API_KEY\n" "$dim" "$INSTALL_DIR" "$off"
printf "  2. run %spager%s inside a tmux session, or %spager <command>%s to wrap one\n" "$dim" "$off" "$dim" "$off"
printf "  3. open %shttp://localhost:4520%s and tap the device to talk\n" "$dim" "$off"
