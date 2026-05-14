# Pager

***Pager has your back.***

A voice agent that lives on your machine. It watches your dev environment and speaks up when something breaks — so you can keep gaming, cooking, parenting, or driving, and still ship.

Your terminal errors → Pager notices → Pager speaks → you reply hands-free → Cursor's agent fixes it.

Built for [ElevenHacks](https://elevenlabs.io/) — Cursor + ElevenLabs hackathon, May 2026.

**Stack:** Bun, TypeScript, ElevenLabs Conversational AI, Cursor Agent CLI, Claude Code subprocess.

## How it works

Local-first. Your machine, your code, your terminal — nothing leaves.

1. **Monitoring.** The `pager` script pipes your terminal output to `/tmp/pager-*.log` and the server tails it for error patterns.
2. **Proactive voice.** On a match, the server bundles context (command, cwd, git state, error tail) and speaks a headline — through system audio, or the browser if a TALK session is open.
3. **The fix.** You reply, and the agent calls **`cursor_agent`** — the **Cursor CLI agent** (`cursor-agent -p`) inspects the code and applies the fix. `run_shell` and `claude_code` are narrow fallbacks.

Every `cursor_agent` call runs on a throwaway branch. Smallest possible change. Never commits, never pushes, never touches `.env`.

## Quick start

Install with one command (clones to `~/.pager`, installs deps, puts `pager` on your PATH):

```bash
curl -fsSL https://raw.githubusercontent.com/Bhavya031/pager/main/install.sh | bash
```

Then fill in your ElevenLabs keys in `~/.pager/.env` and you're ready.

<details>
<summary>Or set up manually from a clone</summary>

```bash
bun install
cp .env.example .env   # then fill in ELEVENLABS_AGENT_ID and ELEVENLABS_API_KEY
```
</details>

### Option A: just the voice agent

```bash
bun run dev
```

Open `http://localhost:4520` in your browser. Tap the pager device to start a voice session.

### Option B: the `pager` command (proactive monitoring)

The `pager` script gives you two ways to invoke proactive monitoring. Both auto-start the local server in the background if it isn't already running.

```bash
# (one-time, optional) make `pager` available globally:
ln -s "$PWD/pager" /usr/local/bin/pager
```

**Mode A — monitor a tmux session.** Inside any tmux pane:

```bash
pager
```

Pipes every currently-open tmux pane's output to `/tmp/pager-pane-*.log`. The watcher tails these and fires an alert when an error pattern matches. Re-run `pager` after opening new panes.

**Mode B — wrap a single command.** Outside tmux (or inside, doesn't matter):

```bash
pager bun run dev
pager npm test
pager cargo build
```

Runs the command, tees its output to `/tmp/pager-cmd-<pid>.log`, watcher catches errors. **The log starts with** `[pager] cmd: …`, `[pager] cwd: …`, `[pager] started: …` **so the agent always knows what ran.**

### Command + output everywhere

- **Mode B** — metadata is written into the log automatically (see above).
- **Mode A (tmux)** — `pipe-pane` only sees characters that were printed. To print **each shell command** next to its output, your shell must echo it. Source one hook in **each** shell you use inside tmux (add to `~/.zshrc` or `~/.bashrc`):

```bash
# zsh (recommended — one line per command, clean)
source /path/to/pager/hooks/pager-shell.zsh

# bash (DEBUG-based; noisier than zsh)
source /path/to/pager/hooks/pager-shell.bash
```

Then re-run `pager` (or restart pipes). Alerts will include `[pager] cmd: …` from the hook plus the program output below it.

In both modes: open `http://localhost:4520` and tap the pager device once to start a TALK session. While that session is active, alerts route through the agent and it speaks proactively.

**You don't have to lift a finger.**

## Tools the agent has

- `cursor_agent(prompt)` — delegates to `cursor-agent -p` (default for nearly any coding/analysis request)
- `run_shell(command)` — runs a shell command, only when the user explicitly asks for one
- `claude_code(prompt)` — delegates to `claude -p` (fallback, only when user says "Claude")

## UI

A pager device on cream. The screen shows live audio — a `<canvas>` overlay with two audio-reactive visualisations, toggleable from the UI:

- **Wave** — filled mirrored waveform; per-column peak detection on the time-domain audio with frame smoothing
- **Cluster** — radial bright cluster; frequency-bin-per-dot with center bias and per-dot offset to break perfect symmetry

## Roadmap

- **Wake-on-error.** Right now alerts only become speech when a TALK session is already active. Next: browser auto-starts a conversation when an alert arrives without an active one (after the user has clicked TALK once to grant mic).
- **Auto-pipe new tmux panes.** Currently `pager` only pipes panes that exist when invoked. A `set-hook -g pane-focus-in 'pipe-pane …'` snippet in `~/.tmux.conf` would auto-pipe new panes; defer until tested.
- **Project-context bootstrap.** Read `package.json` name + `README.md` first paragraph on startup, inject as `dynamic_variable` into the agent's system prompt so it knows what project it's running in.
- **Single-binary install.** Currently requires a clone + Bun. Next: `bun build --compile` → one executable, or an Electron wrapper for a full installer.
