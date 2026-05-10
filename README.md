# Pager

A voice agent that lives on the developer's machine. Monitors the local dev environment and speaks proactively when something needs attention. Designed for moments when the developer's hands are busy (gaming, cooking, parenting, driving).

Built for [ElevenHacks](https://elevenlabs.io/) — Cursor + ElevenLabs hackathon, May 2026.

**Stack:** Bun, TypeScript, ElevenLabs Conversational AI SDK, Cursor Agent CLI, Claude Code subprocess.

## Quick start

```bash
bun install
cp .env.example .env   # then fill in ELEVENLABS_AGENT_ID and ELEVENLABS_API_KEY
bun run dev
```

Open `http://localhost:3030` in Safari or Chrome (Arc's mic is broken). Tap the pager device to start a voice session.

## Tools the agent has

- `cursor_agent(prompt)` — delegates to `cursor-agent -p` (default for nearly any coding/analysis request)
- `run_shell(command)` — runs a shell command, only when the user explicitly asks for one
- `claude_code(prompt)` — delegates to `claude -p` (fallback, only when user says "Claude")

## UI

Photoreal pager device centered on a cream background. The screen overlays a `<canvas>` with two audio-reactive visualisations, toggleable from the UI:

- **Wave** — filled mirrored waveform; per-column peak detection on the time-domain audio with frame smoothing
- **Cluster** — radial bright cluster; frequency-bin-per-dot with center bias and per-dot offset to break perfect symmetry

## Roadmap / if time permits

- **Electron / single-binary distribution.** The hackathon's biggest distribution problem is that judges won't run `bun install + clone + .env setup` to try a local-only tool. Two paths to make this trivially-installable:
  - `bun build --compile` → single executable, smallest lift
  - Electron wrapper → full app with installer, biggest lift but most "real product" feel
  
  Pick based on Day-4 time budget.
- **Proactive voice on local CLI errors.** Watch `tmux pipe-pane` logs for error patterns; have Pager speak first when a dev server crashes mid-task. (Day 3 target.)
- **Project-context bootstrap.** Read `package.json` name + `README.md` first paragraph on startup, inject as `dynamic_variable` into the agent's system prompt so it knows what project it's running in.
