# Pager

A voice agent that lives on the developer's machine. Monitors the local dev environment and speaks proactively when something needs attention. Designed for moments when the developer's hands are busy (gaming, cooking, parenting, driving).

Built for [ElevenHacks](https://elevenlabs.io/) — Cursor + ElevenLabs hackathon, May 2026.

**Stack:** Bun, TypeScript, ElevenLabs Conversational AI SDK, Cursor Agent CLI, Claude Code subprocess.

## Quick start

```bash
bun install
cp .env.example .env   # then fill in ELEVENLABS_AGENT_ID and ELEVENLABS_API_KEY
```

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

## Tools the agent has

- `cursor_agent(prompt)` — delegates to `cursor-agent -p` (default for nearly any coding/analysis request)
- `run_shell(command)` — runs a shell command, only when the user explicitly asks for one
- `claude_code(prompt)` — delegates to `claude -p` (fallback, only when user says "Claude")

## UI

Photoreal pager device centered on a cream background. The screen overlays a `<canvas>` with two audio-reactive visualisations, toggleable from the UI:

- **Wave** — filled mirrored waveform; per-column peak detection on the time-domain audio with frame smoothing
- **Cluster** — radial bright cluster; frequency-bin-per-dot with center bias and per-dot offset to break perfect symmetry

## Roadmap / if time permits

- **Wake-on-error.** Right now alerts only become speech when a TALK session is already active. Day-4 plan: browser auto-starts a conversation when an alert arrives without an active one (after the user has clicked TALK once to grant mic).
- **Auto-pipe new tmux panes.** Currently `pager` only pipes panes that exist when invoked. A `set-hook -g pane-focus-in 'pipe-pane …'` snippet in `~/.tmux.conf` would auto-pipe new panes; defer until tested.
- **Project-context bootstrap.** Read `package.json` name + `README.md` first paragraph on startup, inject as `dynamic_variable` into the agent's system prompt so it knows what project it's running in.
- **Electron / single-binary distribution.** The hackathon's biggest distribution problem is that judges won't run `bun install + clone + .env setup` to try a local-only tool. Two paths to make this trivially-installable:
  - `bun build --compile` → single executable, smallest lift
  - Electron wrapper → full app with installer, biggest lift but most "real product" feel
  
  Pick based on Day-4 time budget.
