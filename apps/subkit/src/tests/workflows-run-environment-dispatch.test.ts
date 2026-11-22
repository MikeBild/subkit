import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ENTRY = resolve(import.meta.dir, "..", "index.ts");
const WORKFLOW_ID = "11111111-1111-4111-8111-111111111111";
const runs: Array<{ environment: string | null; body: Record<string, unknown> }> = [];
let server: ReturnType<typeof Bun.serve>;
let home: string;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "subkit-run-environment-"));
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "POST" && url.pathname === "/v1/executions") {
        const environment = req.headers.get("x-subkit-environment");
        runs.push({ environment, body: (await req.json()) as Record<string, unknown> });
        if (environment !== "prod") {
          return Response.json({
            execution_id: "exec-1",
            status: "failed",
            error: { code: "connector_environment_mismatch" },
            steps: [
              {
                step_key: "write",
                step_index: 0,
                kind: "request",
                status: "failed",
                duration_ms: 1,
                retry_count: 0,
                error: { code: "connector_environment_mismatch" },
              },
            ],
          });
        }
        return Response.json({ execution_id: "exec-2", status: "succeeded", steps: [] });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(home, { recursive: true, force: true });
});

async function subkit(args: string[]) {
  const proc = Bun.spawn(["bun", ENTRY, ...args], {
    env: {
      ...process.env,
      HOME: home,
      NO_COLOR: "1",
      SUBKIT_ENGINE_URL: `http://127.0.0.1:${server.port}`,
      SUBKIT_API_KEY: "sk_test",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("subkit workflows run --environment", () => {
  test("sends prod as x-subkit-environment and reports it", async () => {
    runs.length = 0;
    const r = await subkit(["workflows", "run", WORKFLOW_ID, "--environment", "prod"]);
    expect(r.exitCode).toBe(0);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.environment).toBe("prod");
    expect(runs[0]?.body.workflow_id).toBe(WORKFLOW_ID);
    expect(JSON.parse(r.stdout).environment).toBe("prod");
    expect(r.stderr).toContain("environment: prod");
  }, 30_000);

  test("defaults to dev and points a mismatch at the option", async () => {
    runs.length = 0;
    const r = await subkit(["workflows", "run", WORKFLOW_ID]);
    expect(runs[0]?.environment).toBe("dev");
    expect(JSON.parse(r.stdout).environment).toBe("dev");
    expect(r.stderr).toContain("environment: dev");
    expect(r.stderr).toContain("--environment prod");
  }, 30_000);

  test("refuses an unknown environment before calling the engine", async () => {
    runs.length = 0;
    const r = await subkit(["workflows", "run", WORKFLOW_ID, "--environment", "staging"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("invalid --environment 'staging'");
    expect(runs).toHaveLength(0);
  }, 30_000);
});
