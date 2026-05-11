import { watch } from "node:fs";
import { readdir } from "node:fs/promises";

const AGENT_ID = process.env.ELEVENLABS_AGENT_ID;
const API_KEY = process.env.ELEVENLABS_API_KEY;

if (!AGENT_ID) {
  console.error("Missing ELEVENLABS_AGENT_ID — copy .env.example to .env and fill it in.");
  process.exit(1);
}

if (!API_KEY) {
  console.error("Missing ELEVENLABS_API_KEY — required for private agents. See .env.example.");
  process.exit(1);
}

const PORT = 4520;
const REPO_DIR = import.meta.dir;
const TOOL_TIMEOUT_MS = 30_000;
const AGENT_TIMEOUT_MS = 60_000;
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "tnSpp4vdxKPjI9w0GnoV";

async function getSignedUrl(): Promise<string> {
  const res = await fetch(
    `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${AGENT_ID}`,
    { headers: { "xi-api-key": API_KEY! } },
  );
  if (!res.ok) {
    throw new Error(`signed-url fetch failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as { signed_url: string };
  return data.signed_url;
}

type SpawnResult = { stdout: string; stderr: string; exit_code: number; timed_out: boolean };

// ─── proactive alerts ─────────────────────────────────────────────────────

type Alert = { id: string; paneId: string; content: string; timestamp: number };

const LOG_DIR = "/tmp";
const LOG_FILENAME_RE = /^pager-(pane|cmd)-([\w%]+)\.log$/;
const ERROR_RE =
  /\b(Error|Exception|FAIL(?:URE|ED)?|panic|TypeError|SyntaxError|ReferenceError|RangeError)[:!]|\b(Segmentation fault|cannot find|command not found|core dumped)\b|✗|✘/i;
// Lines pager itself emits — must be filtered out before error-matching so
// pager doesn't alert on its own output when it's running inside a monitored
// tmux pane (e.g. "[alert] pane 1: TypeError…" would recursively trigger).
const PAGER_LOG_LINE_RE = /^\[(alert|tts|sse|watcher|browser|startup|pager|run_shell|claude_code|cursor_agent)/;
const ALERT_COOLDOWN_MS = 5_000;
const ALERT_CONTENT_MAX = 1_500;       // body output cap; agent can fetch more via run_shell tail
const PREAMBLE_MAX = 400;              // bytes to read at file head (Mode B preamble)
const CONTEXT_WINDOW = 4_096;          // bytes to read at file tail (Mode A recent cmds + output)
const PREVIOUS_CMD_LIMIT = 3;          // history depth for the "previous commands" section

const fileOffsets = new Map<string, number>();
const lastAlertAt = new Map<string, number>();
const alertSubscribers = new Set<(a: Alert) => void>();

// The most-recent alert, kept so a freshly-opened tab can find out why the
// server launched it. Older than REPLAY_WINDOW_MS = ignored on connect.
const REPLAY_WINDOW_MS = 60_000;
let lastAlert: Alert | null = null;

function openBrowserPage(): void {
  if (process.env.PAGER_NO_OPEN) return;
  const opener =
    process.platform === "darwin" ? "open" :
    process.platform === "win32"  ? "explorer" :
                                    "xdg-open";
  try {
    Bun.spawn([opener, `http://localhost:${PORT}`], { stdout: "ignore", stderr: "ignore" });
  } catch (err) {
    console.warn(`[browser] couldn't launch ${opener}:`, err);
  }
}

async function readSlice(path: string, start: number, end: number): Promise<string> {
  try {
    const file = Bun.file(path);
    const lo = Math.max(0, Math.min(start, file.size));
    const hi = Math.max(lo, Math.min(end, file.size));
    if (hi <= lo) return "";
    return await file.slice(lo, hi).text();
  } catch {
    return "";
  }
}

// Lightweight `git` runner for alert-context enrichment. 2s race so a
// wedged git invocation can't stall an alert build. Returns null on any
// failure / non-zero exit / missing repo so callers can skip silently.
async function runGit(args: string[], cwd: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    const done = (async () => {
      const text = await new Response(proc.stdout).text();
      await proc.exited;
      return proc.exitCode === 0 ? text : null;
    })();
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000));
    const result = await Promise.race([done, timeout]);
    if (result === null) { try { proc.kill(); } catch {} }
    return result;
  } catch {
    return null;
  }
}

async function gitContext(cwd: string): Promise<string | null> {
  const [branch, status, log] = await Promise.all([
    runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd),
    runGit(["status", "--short"], cwd),
    runGit(["log", "-3", "--oneline"], cwd),
  ]);
  if (!branch && !status && !log) return null; // not a repo, or git is broken
  const lines: string[] = [];
  if (branch?.trim()) lines.push(`[git] branch: ${branch.trim()}`);
  const dirty = status?.trim();
  if (dirty) {
    const truncated = dirty.split("\n").slice(0, 10).map((l) => "  " + l).join("\n");
    lines.push(`[git] uncommitted:\n${truncated}`);
  }
  if (log?.trim()) {
    lines.push(`[git] recent commits:\n${log.trim().split("\n").map((l) => "  " + l).join("\n")}`);
  }
  return lines.length ? lines.join("\n") : null;
}

type AlertContext = { body: string; currentCmd: string | null };

// Build the alert body the agent will see. Always includes the current cmd
// when known (Mode B preamble or Mode A preexec hook), plus a few previous
// cmds for context (Mode A only), plus the log path so the agent can pull
// more output via run_shell if the truncated tail isn't enough.
async function buildAlertBody(path: string, source: string): Promise<AlertContext> {
  const cmdLines: string[] = [];
  let cwdPath: string | null = null;

  const captureMeta = (lines: string[]) => {
    for (const line of lines) {
      if (line.startsWith("[pager] cmd:")) {
        cmdLines.push(line);
      } else if (line.startsWith("[pager] cwd:")) {
        // Most recent cwd wins — Mode A may have many cwds as the user cd's around.
        cwdPath = line.slice("[pager] cwd:".length).trim();
      }
    }
  };

  if (source === "cmd") {
    const head = await readSlice(path, 0, PREAMBLE_MAX);
    captureMeta(head.split("\n"));
  }

  const fileSize = (() => { try { return Bun.file(path).size; } catch { return 0; } })();
  const tail = await readSlice(path, fileSize - CONTEXT_WINDOW, fileSize);

  if (source === "pane") {
    // Mode A: cmd/cwd lines are interleaved in the body via the preexec hook.
    captureMeta(tail.split("\n"));
  }

  const current = cmdLines.length ? cmdLines[cmdLines.length - 1]! : null;
  const previous = cmdLines.slice(0, -1).slice(-PREVIOUS_CMD_LIMIT);

  // Best-effort: pull branch, dirty files, recent commits from the user's
  // cwd. Skips silently if cwd is unknown or not a git repo.
  const gitInfo = cwdPath ? await gitContext(cwdPath) : null;

  // Strip pager's own log lines from the visible body so the agent doesn't
  // see pager's internal chatter as part of the user's error context.
  const outputBody = tail
    .split("\n")
    .filter((l) => !PAGER_LOG_LINE_RE.test(l))
    .join("\n")
    .trim();
  const truncated =
    outputBody.length > ALERT_CONTENT_MAX
      ? "…" + outputBody.slice(-ALERT_CONTENT_MAX)
      : outputBody;

  const sections: string[] = [];
  if (current) sections.push(current);
  if (cwdPath) sections.push(`[pager] cwd: ${cwdPath}`);
  sections.push(`[pager] log: ${path}`);
  if (previous.length) {
    sections.push(`[previous commands:]\n${previous.map((c) => "  " + c).join("\n")}`);
  }
  if (gitInfo) sections.push(gitInfo);
  sections.push("---");
  sections.push(truncated);
  return { body: sections.join("\n"), currentCmd: current };
}

// Short, mission-control-style sentence for the proactive afplay announcement.
// The agent gets full context separately when the user engages.
function briefSummary(body: string, cmdLine: string | null): string {
  let cmd: string | null = null;
  if (cmdLine) {
    const m = /\[pager\] cmd: (.+)/.exec(cmdLine);
    if (m && m[1]) cmd = m[1].trim().slice(0, 40);
  }
  const typeMatch = body.match(/\b(TypeError|SyntaxError|ReferenceError|RangeError|Exception|panic)\b/);
  const errType = typeMatch ? typeMatch[1] : null;
  if (cmd && errType) return `Pager. Your ${cmd} just failed with a ${errType}.`;
  if (cmd)            return `Pager. Your ${cmd} just hit an error.`;
  if (errType)        return `Pager. Caught a ${errType}.`;
  return `Pager. Something just failed.`;
}

// Server-side TTS for proactive announcements: doesn't need a browser tab,
// doesn't need a user gesture, plays through system audio so the user hears
// it while the browser tab is still loading or while they're in another app.
let activeTtsProc: ReturnType<typeof Bun.spawn> | null = null;
async function speakProactive(text: string): Promise<void> {
  if (activeTtsProc && activeTtsProc.exitCode === null) {
    console.log(`[tts] previous announcement still playing — skipping`);
    return;
  }
  console.log(`[tts] "${text}"`);
  try {
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_22050_32`,
      {
        method: "POST",
        headers: { "xi-api-key": API_KEY!, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: "eleven_turbo_v2_5" }),
      },
    );
    if (!res.ok) {
      console.warn(`[tts] elevenlabs ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return;
    }
    const path = `/tmp/pager-tts-${Date.now()}.mp3`;
    await Bun.write(path, await res.arrayBuffer());
    if (process.platform !== "darwin") {
      console.warn(`[tts] saved to ${path}; only macOS afplay wired up`);
      return;
    }
    activeTtsProc = Bun.spawn(["afplay", path], { stdout: "ignore", stderr: "ignore" });
    void activeTtsProc.exited.then(() => Bun.spawn(["rm", "-f", path]));
  } catch (err) {
    console.warn(`[tts] failed:`, err);
  }
}

async function tailFile(path: string, isFresh: boolean): Promise<string | null> {
  try {
    const file = Bun.file(path);
    const size = file.size;
    const prev = fileOffsets.get(path) ?? (isFresh ? 0 : size);
    if (size <= prev) {
      fileOffsets.set(path, size);
      return null;
    }
    // Claim the new offset BEFORE awaiting the read so a concurrent
    // watch+poll fire can't both read the same byte range.
    fileOffsets.set(path, size);
    return await file.slice(prev, size).text();
  } catch {
    return null;
  }
}

async function processLog(path: string, source: string, id: string): Promise<void> {
  const isFresh = source === "cmd";
  const newContent = await tailFile(path, isFresh);
  if (!newContent) return;
  // Strip pager's own log lines before deciding whether this is an alert-
  // worthy error — otherwise pager monitoring a pane it's running in
  // recursively alerts on its own output.
  const userContent = newContent
    .split("\n")
    .filter((l) => !PAGER_LOG_LINE_RE.test(l))
    .join("\n");
  if (!ERROR_RE.test(userContent)) return;

  const key = `${source}:${id}`;
  const now = Date.now();
  const last = lastAlertAt.get(key) ?? 0;
  if (now - last < ALERT_COOLDOWN_MS) return;
  lastAlertAt.set(key, now);

  const ctx = await buildAlertBody(path, source);
  const label = source === "pane" ? `pane ${id}` : `command (pid ${id})`;
  const alert: Alert = {
    id: crypto.randomUUID(),
    paneId: label,
    content: ctx.body,
    timestamp: now,
  };
  const preview = newContent.trim().slice(0, 100).replace(/\n/g, " ⏎ ");
  console.log(`[alert] ${label} → ${alertSubscribers.size} subscriber(s): ${preview}…`);
  lastAlert = alert;
  if (alertSubscribers.size === 0) {
    // Hands-free path: speak the headline via system audio, then open the
    // tab so the user can engage if they want to. Full context is already
    // in lastAlert and will replay on SSE connect.
    console.log(`[alert]   no browser connected — speaking + launching tab`);
    void speakProactive(briefSummary(newContent, ctx.currentCmd));
    openBrowserPage();
  } else {
    // Tab is open → browser handles the alert (live to active conversation
    // or via ensureVoiceSession if the user previously clicked TALK).
    for (const sub of alertSubscribers) sub(alert);
  }
}

// Boot-time prime: skip historical content in pre-existing log files so
// every server restart doesn't re-emit ancient errors as fresh alerts.
async function primeExistingOffsets(): Promise<void> {
  try {
    const files = await readdir(LOG_DIR);
    let primed = 0;
    for (const f of files) {
      if (!LOG_FILENAME_RE.test(f)) continue;
      const path = `${LOG_DIR}/${f}`;
      try {
        fileOffsets.set(path, Bun.file(path).size);
        primed++;
      } catch {}
    }
    console.log(`[watcher] primed ${primed} existing log(s); ignoring historical content`);
  } catch {}
}
await primeExistingOffsets();

try {
  watch(LOG_DIR, (_event, filename) => {
    if (!filename) return;
    const m = LOG_FILENAME_RE.exec(filename);
    if (!m || !m[1] || !m[2]) return;
    void processLog(`${LOG_DIR}/${filename}`, m[1], m[2]);
  });
  console.log(`[watcher] watching ${LOG_DIR}/pager-{pane,cmd}-*.log for errors`);
} catch (err) {
  console.error(`[watcher] failed to watch ${LOG_DIR}:`, err);
}

// fs.watch on macOS doesn't reliably fire for `tee >> file` from external
// processes (e.g. tmux pipe-pane). Poll as a backstop.
const POLL_INTERVAL_MS = 1_000;
setInterval(async () => {
  try {
    const files = await readdir(LOG_DIR);
    const validPaths = new Set<string>();
    const validKeys = new Set<string>();
    for (const f of files) {
      const m = LOG_FILENAME_RE.exec(f);
      if (!m || !m[1] || !m[2]) continue;
      const path = `${LOG_DIR}/${f}`;
      validPaths.add(path);
      validKeys.add(`${m[1]}:${m[2]}`);
      await processLog(path, m[1], m[2]);
    }
    // Drop entries for logs that have been deleted so the maps don't grow forever.
    for (const path of fileOffsets.keys()) if (!validPaths.has(path)) fileOffsets.delete(path);
    for (const key of lastAlertAt.keys()) if (!validKeys.has(key)) lastAlertAt.delete(key);
  } catch {}
}, POLL_INTERVAL_MS);
console.log(`[watcher] also polling ${LOG_DIR} every ${POLL_INTERVAL_MS}ms (fs.watch backstop)`);

async function runWithTimeout(
  cmd: string[],
  cwd: string,
  timeoutMs: number = TOOL_TIMEOUT_MS,
): Promise<SpawnResult> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });

  const timeout = new Promise<"timeout">((resolve) =>
    setTimeout(() => resolve("timeout"), timeoutMs),
  );
  const finish = (async () => {
    await proc.exited;
    return "done" as const;
  })();

  const winner = await Promise.race([timeout, finish]);

  if (winner === "timeout") {
    proc.kill();
    return {
      stdout: "",
      stderr: `Command timed out after ${timeoutMs / 1000}s`,
      exit_code: -1,
      timed_out: true,
    };
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exit_code: proc.exitCode ?? -1, timed_out: false };
}

// ─── tool dispatch table ──────────────────────────────────────────────────

type ToolName = "run_shell" | "claude_code" | "cursor_agent";
type ToolSpec = {
  paramName: "command" | "prompt";
  argv: (input: string) => string[];
  timeoutMs: number;
};

// Prepended to every cursor_agent invocation. Branch isolation + scope
// limits + no-commit/no-push/no-merge — last line of defence in case the
// system prompt drifts. cursor-agent treats this as part of the user prompt.
const CURSOR_AGENT_PREFIX = `WORKFLOW RULES (must follow):
- Before modifying any file, create and check out a branch:
    git checkout -b "pager-auto/$(date +%s)"
- Make the smallest possible change. Do not refactor unrelated code.
- Do not modify files outside the failing area.
- Never touch: package.json, lockfiles, .env*, CI configs, migrations.
- Do not commit. Do not push. Do not merge.
- After applying changes, run \`git diff main\` and print the diff in your reply.
- If the fix would need >30 lines or touch >2 files, STOP — print the
  proposed plan and do not apply it.

USER REQUEST:
`;

const TOOLS: Record<ToolName, ToolSpec> = {
  run_shell:    { paramName: "command", argv: (c) => ["sh", "-c", c],                              timeoutMs: TOOL_TIMEOUT_MS },
  claude_code:  { paramName: "prompt",  argv: (p) => ["claude", "-p", p],                          timeoutMs: AGENT_TIMEOUT_MS },
  cursor_agent: { paramName: "prompt",  argv: (p) => ["cursor-agent", "-p", "--trust", "--force", CURSOR_AGENT_PREFIX + p], timeoutMs: AGENT_TIMEOUT_MS },
};
const TOOL_ROUTE_RE = /^\/api\/(run_shell|claude_code|cursor_agent)$/;

// Shell-command denylist. Conservative, easy-to-bypass with deliberate
// quoting — but the agent isn't adversarial, just occasionally reckless.
// Returned via stderr so the agent reports the block to the user naturally.
const SHELL_DENY_PATTERNS: { re: RegExp; reason: string }[] = [
  { re: /\brm\s+-[a-z]*[rRf]/i,                       reason: "rm -r/-f blocked" },
  { re: /\bgit\s+push\s+(?:.*\s)?(?:--force|-f\b)/i,  reason: "force push blocked" },
  { re: /\bgit\s+reset\s+--hard/i,                    reason: "git reset --hard blocked" },
  { re: /\bgit\s+clean\s+-[a-z]*[fdx]/i,              reason: "git clean -f/-d/-x blocked" },
  { re: /\bgit\s+checkout\s+--\s/i,                   reason: "git checkout -- (discard) blocked" },
  { re: /\bnpm\s+publish\b/i,                         reason: "npm publish blocked" },
  { re: /\bbun\s+publish\b/i,                         reason: "bun publish blocked" },
  { re: /\bgh\s+repo\s+delete\b/i,                    reason: "gh repo delete blocked" },
  { re: /\bsudo\b/i,                                  reason: "sudo blocked" },
  { re: /\bdd\s+(?:if|of)=/i,                         reason: "dd blocked" },
  { re: /\bmkfs\b/i,                                  reason: "mkfs blocked" },
  { re: /\b(?:shutdown|reboot|halt|poweroff)\b/i,     reason: "system power command blocked" },
  { re: /\bchmod\s+(?:0?777|a\+rwx)\b/i,              reason: "chmod 777 blocked" },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,   reason: "fork bomb blocked" },
];
function checkShellSafety(cmd: string): { ok: true } | { ok: false; reason: string } {
  for (const { re, reason } of SHELL_DENY_PATTERNS) {
    if (re.test(cmd)) return { ok: false, reason };
  }
  return { ok: true };
}

const VENDOR: Record<string, { path: string; cache: string }> = {
  "/vendor/elevenlabs-client.js": {
    path: "node_modules/@elevenlabs/client/dist/lib.iife.js",
    cache: "public, max-age=3600",
  },
  "/vendor/libsamplerate.worklet.js": {
    path: "node_modules/@alexanderolsen/libsamplerate-js/dist/libsamplerate.worklet.js",
    cache: "public, max-age=86400",
  },
};

Bun.serve({
  port: PORT,
  // SSE on /api/alerts is long-lived; Bun's default 10s idle timeout would
  // kill it before the 10s heartbeat could keep it warm. 255 is Bun's max.
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await Bun.file("./public/index.html").text();
      return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (req.method === "GET" && VENDOR[url.pathname]) {
      const v = VENDOR[url.pathname]!;
      const file = Bun.file(`${REPO_DIR}/${v.path}`);
      if (!(await file.exists())) {
        return new Response(`Run \`bun install\` — missing ${v.path}`, { status: 500 });
      }
      return new Response(file, {
        headers: {
          "Content-Type": "application/javascript; charset=utf-8",
          "Cache-Control": v.cache,
        },
      });
    }

    if (url.pathname === "/api/signed-url") {
      try {
        return Response.json({ signedUrl: await getSignedUrl() });
      } catch (err) {
        console.error(err);
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    const toolMatch = TOOL_ROUTE_RE.exec(url.pathname);
    if (toolMatch && req.method === "POST") {
      const toolName = toolMatch[1] as ToolName;
      const tool = TOOLS[toolName];
      try {
        const body = (await req.json()) as Record<string, unknown>;
        const input = body[tool.paramName];
        if (typeof input !== "string" || !input) {
          return Response.json({ error: `missing '${tool.paramName}'` }, { status: 400 });
        }
        if (toolName === "run_shell") {
          const safety = checkShellSafety(input);
          if (!safety.ok) {
            console.warn(`[run_shell] BLOCKED: ${safety.reason} → ${input.slice(0, 80)}`);
            return Response.json({
              stdout: "",
              stderr: `[pager safety] ${safety.reason}. Tell the user to run this manually if they really need it.`,
              exit_code: -2,
              timed_out: false,
            });
          }
        }
        const preview = input.length > 80 ? input.slice(0, 80) + "..." : input;
        console.log(`[${toolName}] ${preview}`);
        const result = await runWithTimeout(tool.argv(input), REPO_DIR, tool.timeoutMs);
        return Response.json(result);
      } catch (err) {
        console.error(err);
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/api/alerts" && req.method === "GET") {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const enc = new TextEncoder();
          const send = (alert: Alert) => {
            try {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(alert)}\n\n`));
            } catch {}
          };
          alertSubscribers.add(send);
          console.log(`[sse] browser connected (${alertSubscribers.size} active)`);
          try { controller.enqueue(enc.encode(": connected\n\n")); } catch {}
          // Replay the alert that caused us to open this tab, if it's still fresh.
          if (lastAlert && Date.now() - lastAlert.timestamp < REPLAY_WINDOW_MS) {
            console.log(`[sse]   replaying recent alert ${lastAlert.id}`);
            send(lastAlert);
          }
          const ping = setInterval(() => {
            try { controller.enqueue(enc.encode(": ping\n\n")); } catch {}
          }, 10_000);
          req.signal.addEventListener("abort", () => {
            alertSubscribers.delete(send);
            clearInterval(ping);
            console.log(`[sse] browser disconnected (${alertSubscribers.size} active)`);
            try { controller.close(); } catch {}
          });
        },
      });
      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    if (url.pathname === "/api/tts-stop" && req.method === "POST") {
      // Browser calls this when its conversation goes live so the proactive
      // afplay announcement doesn't overlap with the agent's voice.
      if (activeTtsProc && activeTtsProc.exitCode === null) {
        console.log(`[tts] stopping announcement — browser conversation took over`);
        try { activeTtsProc.kill(); } catch {}
      }
      return Response.json({ ok: true });
    }

    if (url.pathname === "/api/test-alert" && req.method === "POST") {
      try {
        const body = (await req.json().catch(() => ({}))) as Partial<Alert>;
        const alert: Alert = {
          id: crypto.randomUUID(),
          paneId: body.paneId || "test",
          content:
            body.content ||
            "[pager] cmd: node -e \"throw new TypeError('demo crash')\"\n[pager] cwd: /Users/demo/proj\n---\nTypeError: demo crash\n  at [eval]:1:7\nbun: process exited with code 1",
          timestamp: Date.now(),
        };
        console.log(`[alert:test] ${alert.paneId}`);
        for (const sub of alertSubscribers) sub(alert);
        return Response.json({ ok: true, subscribers: alertSubscribers.size });
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    if (req.method === "GET" && !url.pathname.startsWith("/api/") && !url.pathname.includes("..")) {
      const file = Bun.file(`./public${url.pathname}`);
      if (await file.exists()) return new Response(file);
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Pager listening on http://localhost:${PORT}`);
console.log(`  cwd for tools: ${REPO_DIR}`);

// Browser only opens on demand (when an alert fires with no connected tab).
// User doesn't need to keep the tab open all the time.
