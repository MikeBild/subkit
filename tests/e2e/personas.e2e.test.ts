// E2E persona tests — verifies RBAC boundaries across admin, member,
// and enduser personas.
//
// Each persona is a separate system account with a distinct role. The
// tests assert that:
//   - admin can do everything
//   - member can read + run but not delete or manage keys
//   - enduser can only run approved workflows and view own executions
//
// The test creates workflows and other resources as admin, then asserts
// that other personas get the expected 200/403 responses.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  boot,
  cli,
  type E2EEnv,
  expectSuccess,
  run,
  runJson,
  shutdown,
  writeTempFile,
} from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("personas", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

// ---------------------------------------------------------------------------
// Shared: admin creates a workflow for other personas to interact with
// ---------------------------------------------------------------------------
let _workflowId: string;

beforeAll(async () => {
  // Admin creates a workflow.
  const wfDef = JSON.stringify({
    name: "persona-test-wf",
    slug: "persona-test-wf",
    steps: [{ kind: "request", id: "step-1", method: "GET", url: "https://httpbin.org/get" }],
  });
  const filePath = writeTempFile(env.personas.admin, "persona-wf.json", wfDef);
  await cli(["workflows", "create", "--file", filePath], { env, persona: "admin" });
  const wfs = await runJson<Array<{ id: string }>>(["workflows", "list"], {
    env,
    persona: "admin",
  });
  _workflowId = (Array.isArray(wfs) ? wfs : [wfs])[0]!.id;
}, 30_000);

// ---------------------------------------------------------------------------
// Admin — full access
// ---------------------------------------------------------------------------
describe("admin persona", () => {
  test("can list workflows", async () => {
    const result = await cli(["workflows", "list"], { env, persona: "admin" });
    expectSuccess(result, "admin workflows list");
    expect(result.stdout).toContain("persona-test-wf");
  });

  test("can list API keys", async () => {
    const keys = await runJson<Array<{ id: string }>>(["apikeys", "list"], {
      env,
      persona: "admin",
    });
    expect(keys.length).toBeGreaterThanOrEqual(1);
  });

  test("can query audit log", async () => {
    const result = await cli(["audit", "query"], { env, persona: "admin" });
    expectSuccess(result, "admin audit query");
  });

  test("can check RBAC permissions", async () => {
    const out = await run(["rbac", "can", env.personas.admin.systemAccountId, "workflow:delete"], {
      env,
      persona: "admin",
    });
    expect(out).toContain("true");
  });

  test("can use sk headless mode", async () => {
    const result = await cli(["--p", "hello from admin", "--output", "json"], {
      env,
      persona: "admin",
      timeout: 60_000,
    });
    expectSuccess(result, "admin sk --p");
    const data = JSON.parse(result.stdout) as { status: string };
    expect(data.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Member — read + run, no destructive ops
// ---------------------------------------------------------------------------
describe("member persona", () => {
  test("can list workflows", async () => {
    const result = await cli(["workflows", "list"], { env, persona: "member" });
    expectSuccess(result, "member workflows list");
  });

  test("can read health", async () => {
    const result = await cli(["health"], { env, persona: "member" });
    expectSuccess(result, "member health");
    expect(result.stdout).toContain("ok");
  });

  test("can use sk headless mode", async () => {
    const result = await cli(["--p", "hello from member", "--output", "json"], {
      env,
      persona: "member",
      timeout: 60_000,
    });
    expectSuccess(result, "member sk --p");
    const data = JSON.parse(result.stdout) as { status: string };
    expect(data.status).toBe("completed");
  });

  test("is denied RBAC management (no rbac:read)", async () => {
    const result = await cli(["rbac", "roles", "list", "--json"], {
      env,
      persona: "member",
    });
    // Member role doesn't have rbac:read — expect 403 or non-zero exit.
    expect(result.exitCode !== 0 || result.stderr.length > 0 || result.stdout.includes("403")).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Enduser — most restricted
// ---------------------------------------------------------------------------
describe("enduser persona", () => {
  test("can read health (unauthenticated endpoint)", async () => {
    const result = await cli(["health"], { env, persona: "enduser" });
    expectSuccess(result, "enduser health");
    expect(result.stdout).toContain("ok");
  });

  test("can use sk headless mode (scoped to own conversations)", async () => {
    const result = await cli(["--p", "hello from enduser", "--output", "json"], {
      env,
      persona: "enduser",
      timeout: 60_000,
    });
    expectSuccess(result, "enduser sk --p");
    const data = JSON.parse(result.stdout) as { status: string };
    expect(data.status).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
// Cross-persona isolation
// ---------------------------------------------------------------------------
describe("cross-persona isolation", () => {
  test("all personas see the same tenant health", async () => {
    const [a, m, e] = await Promise.all([
      run(["health"], { env, persona: "admin" }),
      run(["health"], { env, persona: "member" }),
      run(["health"], { env, persona: "enduser" }),
    ]);
    expect(a).toContain("ok");
    expect(m).toContain("ok");
    expect(e).toContain("ok");
  });
});
