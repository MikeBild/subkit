// Docker-backed smoke for the two end-user surfaces highlighted in the
// zero-to-running guide: the MCP embedding (Codex streamable-HTTP path) and the
// conversational REPL loop (driven headless — same engine the TUI uses).
//
// Self-contained: starts a fresh all-in-one container, bootstraps it with the
// keyless `mock` LLM provider (no secret needed), mints an admin key, then:
//   1. MCP: POST {engine}/mcp with `Authorization: Bearer <key>` →
//      initialize + tools/list returns the tenant tool surface (author_workflow,
//      test_connector, dry_run_workflow, …). This is exactly how Codex / Claude
//      Desktop / Cursor connect.
//   2. REPL loop: `sk -p "<prompt>"` (the REPL's headless drive) runs a turn to
//      completion without a provider/internal error.
//
// Run:  SMOKE_IMAGE=mikebild/subkit:7.2.1 bun run tests/e2e/onboarding-surfaces.smoke.ts
// Exit: 0 = all green, 1 = a check failed (prints ✓/✘ per step).

import { spawnSync } from "node:child_process";

const IMAGE = process.env.SMOKE_IMAGE ?? "mikebild/subkit:latest";
const NAME = process.env.SMOKE_NAME ?? "subkit-smoke";
const PORT = Number(process.env.SMOKE_PORT ?? "3099");
const VOL = `${NAME}-data`;
const BASE = `http://localhost:${PORT}`;

function ok(msg: string): void {
  console.log(`✓ ${msg}`);
}
function fail(msg: string): never {
  console.error(`✘ ${msg}`);
  teardown();
  process.exit(1);
}
function sh(cmd: string, args: string[]): { status: number; out: string } {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function dockerExec(args: string[]): { status: number; out: string } {
  return sh("docker", ["exec", NAME, ...args]);
}
function teardown(): void {
  sh("docker", ["rm", "-f", NAME]);
  sh("docker", ["volume", "rm", VOL]);
}

async function main(): Promise<void> {
  teardown();
  if (
    sh("docker", ["run", "-d", "--name", NAME, "-p", `${PORT}:3000`, "-v", `${VOL}:/data`, IMAGE])
      .status !== 0
  ) {
    fail(`could not start container from ${IMAGE}`);
  }

  // Poll health.
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        healthy = true;
        break;
      }
    } catch {
      /* not up yet */
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  if (!healthy) fail("engine did not become healthy");
  ok(`engine healthy (${IMAGE})`);

  // Bootstrap with the keyless mock provider — token auto-detected from the volume.
  const init = dockerExec([
    "sk",
    "init",
    "--admin-email",
    "you@example.com",
    "--tenant-name",
    "My Org",
    "--llm-provider",
    "mock",
    "--llm-api-key",
    "mock",
  ]);
  if (!/bootstrap complete/.test(init.out)) fail(`sk init failed: ${init.out.trim()}`);
  ok("bootstrapped (mock provider, token auto-detected)");

  // Mint an admin key (the Codex path needs a Bearer key).
  const issued = dockerExec(["engine", "--issue-admin-key", "--tenant", "my-org"]);
  const key = issued.out.match(/wf_live_[A-Za-z0-9_-]+/)?.[0];
  if (!key) fail(`could not mint admin key: ${issued.out.trim()}`);
  ok("minted admin key");
  // The issue-admin-key banner should be copy-paste (includes `sk login --engine-url`).
  if (!/sk login --engine-url .* --api-key /.test(issued.out)) {
    fail("issue-admin-key did not print a copy-paste `sk login` line");
  }
  ok("issue-admin-key prints a copy-paste `sk login` line");

  // ── 1. MCP (Codex streamable-HTTP) ──────────────────────────────────────────
  let sessionId: string | null = null;
  const mcpCall = async (method: string, params: Record<string, unknown>) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const r = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: `${method}-1`, method, params }),
    });
    const sid = r.headers.get("mcp-session-id");
    if (sid && !sessionId) sessionId = sid;
    const text = (await r.text()).trim();
    const body =
      text.startsWith("event:") || text.startsWith("data:")
        ? JSON.parse(
            text
              .split("\n")
              .find((l) => l.startsWith("data:"))!
              .slice(5)
              .trim(),
          )
        : JSON.parse(text);
    return { status: r.status, body };
  };

  const initRes = await mcpCall("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  if (initRes.status !== 200 || !sessionId)
    fail(`MCP initialize failed (status ${initRes.status}, session ${sessionId})`);
  ok("MCP initialize → 200 + mcp-session-id (Codex streamable-HTTP path)");

  const listRes = await mcpCall("tools/list", {});
  const tools: Array<{ name: string }> =
    (listRes.body?.result?.tools as Array<{ name: string }>) ?? [];
  const names = new Set(tools.map((t) => t.name));
  if (tools.length < 10) fail(`MCP tools/list returned only ${tools.length} tools`);
  for (const required of ["author_workflow", "test_connector"]) {
    if (!names.has(required))
      fail(`MCP tools/list missing '${required}' (got ${tools.length} tools)`);
  }
  ok(`MCP tools/list → ${tools.length} tenant tools (incl. author_workflow, test_connector)`);

  // ── 2. REPL loop (headless drive of the same engine) ────────────────────────
  const turn = dockerExec([
    "sk",
    "-p",
    "list my workflows",
    "--output",
    "text",
    "--max-turns",
    "4",
  ]);
  if (turn.status !== 0) fail(`headless REPL turn exited ${turn.status}: ${turn.out.trim()}`);
  if (/internal error|misconfigured/i.test(turn.out))
    fail(`headless REPL turn surfaced an error: ${turn.out.trim()}`);
  ok("REPL loop runs a turn to completion (headless, no errors)");

  teardown();
  console.log("\nAll onboarding-surface smoke checks passed.");
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
