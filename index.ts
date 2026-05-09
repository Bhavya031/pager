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

const PORT = 3030;
const REPO_DIR = import.meta.dir;
const TOOL_TIMEOUT_MS = 30_000;
// Agent subprocesses (cursor-agent, claude -p) can run multi-step reasoning;
// give them more headroom than a plain shell command.
const AGENT_TIMEOUT_MS = 60_000;

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

async function runWithTimeout(
  cmd: string[],
  cwd: string,
  timeoutMs: number = TOOL_TIMEOUT_MS,
): Promise<SpawnResult> {
  const proc = Bun.spawn(cmd, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

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

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = await Bun.file("./public/index.html").text();
      return new Response(html, {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/api/signed-url") {
      try {
        const signedUrl = await getSignedUrl();
        return Response.json({ signedUrl });
      } catch (err) {
        console.error(err);
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/api/run_shell" && req.method === "POST") {
      try {
        const { command } = (await req.json()) as { command: string };
        if (!command || typeof command !== "string") {
          return Response.json({ error: "missing 'command'" }, { status: 400 });
        }
        console.log(`[run_shell] ${command}`);
        const result = await runWithTimeout(["sh", "-c", command], REPO_DIR);
        return Response.json(result);
      } catch (err) {
        console.error(err);
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/api/claude_code" && req.method === "POST") {
      try {
        const { prompt } = (await req.json()) as { prompt: string };
        if (!prompt || typeof prompt !== "string") {
          return Response.json({ error: "missing 'prompt'" }, { status: 400 });
        }
        console.log(`[claude_code] ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}`);
        const result = await runWithTimeout(["claude", "-p", prompt], REPO_DIR, AGENT_TIMEOUT_MS);
        return Response.json(result);
      } catch (err) {
        console.error(err);
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    if (url.pathname === "/api/cursor_agent" && req.method === "POST") {
      try {
        const { prompt } = (await req.json()) as { prompt: string };
        if (!prompt || typeof prompt !== "string") {
          return Response.json({ error: "missing 'prompt'" }, { status: 400 });
        }
        console.log(`[cursor_agent] ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}`);
        const result = await runWithTimeout(
          ["cursor-agent", "-p", "--trust", "--force", prompt],
          REPO_DIR,
          AGENT_TIMEOUT_MS,
        );
        return Response.json(result);
      } catch (err) {
        console.error(err);
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`Pager listening on http://localhost:${PORT}`);
console.log(`  cwd for tools: ${REPO_DIR}`);
