// Docker-backed smoke for the two end-user surfaces highlighted in the
// zero-to-running guide: MCP over streamable HTTP and the conversational REPL.
//
// The production application container is intentionally stateless. This smoke
// therefore uses docker-compose.test.yml to provide external PostgreSQL and S3
// services and asserts that the engine itself has no mounts.
//
// Run: SMOKE_IMAGE=mikebild/subkit:6.22.46 bun run smoke:surfaces

import { spawnSync } from "node:child_process";

const IMAGE = process.env.SMOKE_IMAGE ?? "subkit:cintest";
const NAME = process.env.SMOKE_NAME ?? "subkit-smoke";
const PORT = Number(process.env.SMOKE_PORT ?? "3099");
const BASE = `http://127.0.0.1:${PORT}`;

process.env.COMPOSE_PROJECT_NAME = NAME;
process.env.SUBKIT_TEST_IMAGE = IMAGE;
process.env.SUBKIT_TEST_PORT = String(PORT);
process.env.SUBKIT_DOCKER_BASE_URL = BASE;

type Harness = typeof import("../docker/_harness.ts");
let harness: Harness | null = null;

function ok(message: string): void {
  console.log(`✓ ${message}`);
}

function teardown(): void {
  harness?.composeDown();
}

function fail(message: string): never {
  console.error(`✘ ${message}`);
  teardown();
  process.exit(1);
}

async function main(): Promise<void> {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    fail("Docker is unavailable");
  }

  harness = await import("../docker/_harness.ts");
  teardown();
  const env = await harness.dockerBoot();
  if (harness.engineMounts().length !== 0) fail("engine container unexpectedly has mounts");
  ok(`stateless engine healthy with external PostgreSQL/S3 (${IMAGE})`);

  const issued = harness.issueAdminKeyViaExec("default");
  if (issued.status !== 0 || !/wf_live_[A-Za-z0-9_-]+/.test(`${issued.stdout}\n${issued.stderr}`)) {
    fail(`could not mint admin key: ${issued.stdout}${issued.stderr}`);
  }
  if (!/sk login --engine-url .* --api-key /.test(`${issued.stdout}\n${issued.stderr}`)) {
    fail("issue-admin-key did not print a copy-paste `sk login` line");
  }
  ok("operator key issuance is copy-paste ready");

  let sessionId: string | null = null;
  const mcpCall = async (method: string, params: Record<string, unknown>) => {
    const headers: Record<string, string> = {
      authorization: `Bearer ${env.adminKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (sessionId) headers["mcp-session-id"] = sessionId;
    const response = await fetch(`${BASE}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: `${method}-1`, method, params }),
    });
    const assigned = response.headers.get("mcp-session-id");
    if (assigned && !sessionId) sessionId = assigned;
    const text = (await response.text()).trim();
    const body =
      text.startsWith("event:") || text.startsWith("data:")
        ? JSON.parse(
            text
              .split("\n")
              .find((line) => line.startsWith("data:"))!
              .slice(5)
              .trim(),
          )
        : JSON.parse(text);
    return { status: response.status, body };
  };

  const initialized = await mcpCall("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.0.0" },
  });
  if (initialized.status !== 200 || !sessionId) fail("MCP initialize failed");
  const listed = await mcpCall("tools/list", {});
  const tools = (listed.body?.result?.tools as Array<{ name: string }> | undefined) ?? [];
  const names = new Set(tools.map((tool) => tool.name));
  for (const required of ["author_workflow", "test_connector"]) {
    if (!names.has(required)) fail(`MCP tools/list missing '${required}'`);
  }
  ok(`MCP streamable-HTTP exposes ${tools.length} tenant tools`);

  const turn = await harness.skDocker(
    env,
    ["-p", "list my workflows", "--output", "text", "--max-turns", "4"],
    { timeout: 60_000 },
  );
  if (turn.exitCode !== 0 || /internal error|misconfigured/i.test(turn.stdout + turn.stderr)) {
    fail(`headless REPL failed: ${turn.stdout}${turn.stderr}`);
  }
  ok("REPL completes a headless turn without errors");

  teardown();
  console.log("\nAll onboarding-surface smoke checks passed.");
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
