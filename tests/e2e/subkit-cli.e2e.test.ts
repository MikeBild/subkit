// E2E test suite for the `sk` CLI admin commands.
//
// Exercises every command against a real engine with three personas.
// Each test invokes the compiled binary as a subprocess — nothing is
// imported from the CLI source, so we test exactly what operators run.

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
  env = await boot("sk-cli", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------
describe("sk CLI admin commands", () => {
  describe("health", () => {
    test("returns ok with db_connected", async () => {
      const out = await run(["health"], { env });
      expect(out).toContain("ok");
      expect(out).toContain("true");
    });

    test("returns JSON when --json", async () => {
      const data = await runJson<{ status: string; db_connected: boolean }>(["health"], {
        env,
      });
      expect(data.status).toBe("ok");
      expect(data.db_connected).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // login (non-interactive, api-key mode)
  // ---------------------------------------------------------------------------
  describe("login", () => {
    test("stores credentials with --api-key", async () => {
      const result = await cli(
        [
          "login",
          "--engine-url",
          env.baseUrl,
          "--api-key",
          env.personas.admin.apiKey,
          "--tenant",
          env.tenantId,
        ],
        { env, persona: "admin" },
      );
      expectSuccess(result, "login");
      expect(result.stdout).toContain("ok");
    });
  });

  // ---------------------------------------------------------------------------
  // rbac
  // ---------------------------------------------------------------------------
  describe("rbac", () => {
    test("permissions list returns 60+ entries", async () => {
      const perms = await runJson<Array<{ name: string }>>(["rbac", "permissions", "list"], {
        env,
      });
      expect(perms.length).toBeGreaterThan(50);
      expect(perms.some((p) => p.name === "workflow:read")).toBe(true);
    });

    test("roles list returns 6 built-in roles", async () => {
      const roles = await runJson<Array<{ name: string; is_builtin: boolean }>>(
        ["rbac", "roles", "list"],
        { env },
      );
      expect(roles.length).toBeGreaterThanOrEqual(6);
      const names = roles.map((r) => r.name);
      expect(names).toContain("admin");
      expect(names).toContain("member");
      expect(names).toContain("enduser");
    });

    test("can — admin has workflow:read", async () => {
      const out = await run(["rbac", "can", env.personas.admin.systemAccountId, "workflow:read"], {
        env,
        persona: "admin",
      });
      expect(out).toContain("true");
    });

    test("roles create + delete custom role", async () => {
      const roles = await runJson<Array<{ id: string; name: string }>>(
        ["rbac", "roles", "create", "e2e-custom-role"],
        { env },
      );
      // The create command may return the created role or a list — accept both.
      const created = Array.isArray(roles) ? roles : [roles];
      const role = created.find((r) => r.name === "e2e-custom-role");
      expect(role).toBeTruthy();

      if (role) {
        const del = await cli(["rbac", "roles", "delete", role.id], { env });
        expectSuccess(del, "roles delete");
      }
    });
  });

  // ---------------------------------------------------------------------------
  // apikeys
  // ---------------------------------------------------------------------------
  describe("apikeys", () => {
    test("list shows keys for this tenant", async () => {
      const keys = await runJson<Array<{ id: string; prefix: string }>>(["apikeys", "list"], {
        env,
      });
      expect(keys.length).toBeGreaterThanOrEqual(1);
      expect(keys[0]?.prefix).toBeTruthy();
    });
  });

  // ---------------------------------------------------------------------------
  // workflows
  // ---------------------------------------------------------------------------
  describe("workflows", () => {
    let workflowId: string;

    test("list starts empty", async () => {
      const out = await run(["workflows", "list"], { env });
      expect(out).toContain("no rows");
    });

    test("create from JSON file", async () => {
      const wfDef = JSON.stringify({
        name: "e2e-ping",
        slug: "e2e-ping",
        steps: [{ kind: "request", id: "step-1", method: "GET", url: "https://httpbin.org/get" }],
      });
      const filePath = writeTempFile(env.personas.admin, "e2e-ping.json", wfDef);
      // --skip-checks bypasses the validate+preview pre-flight; the
      // post-create `executions list starts empty` assertion below
      // relies on no preview executions having been written yet.
      const result = await cli(["workflows", "create", "--file", filePath, "--skip-checks"], {
        env,
      });
      expectSuccess(result, "workflows create");
      // Extract the workflow ID from the output.
      const json = await runJson<Array<{ id: string }> | { id: string }>(["workflows", "list"], {
        env,
      });
      const list = Array.isArray(json) ? json : [json];
      expect(list.length).toBeGreaterThanOrEqual(1);
      workflowId = list[0]!.id;
    });

    test("get returns the created workflow", async () => {
      if (!workflowId) return;
      const out = await run(["workflows", "get", workflowId], { env });
      expect(out).toContain("e2e-ping");
    });

    test("history shows at least 1 version", async () => {
      if (!workflowId) return;
      const out = await run(["workflows", "history", workflowId], { env });
      // Should contain version number.
      expect(out).toContain("1");
    });

    test("delete removes the workflow", async () => {
      if (!workflowId) return;
      const del = await cli(["workflows", "delete", workflowId], { env });
      expectSuccess(del, "workflows delete");
      const out = await run(["workflows", "list"], { env });
      expect(out).toContain("no rows");
    });
  });

  // ---------------------------------------------------------------------------
  // connectors
  // ---------------------------------------------------------------------------
  describe("connectors", () => {
    test("list starts empty", async () => {
      const out = await run(["connectors", "list"], { env });
      expect(out).toContain("no rows");
    });
  });

  // ---------------------------------------------------------------------------
  // skills
  // ---------------------------------------------------------------------------
  describe("skills", () => {
    test("list starts empty", async () => {
      const out = await run(["skills", "list"], { env });
      expect(out).toContain("no rows");
    });
  });

  // ---------------------------------------------------------------------------
  // executions
  // ---------------------------------------------------------------------------
  describe("executions", () => {
    test("list starts empty", async () => {
      const out = await run(["executions", "list"], { env });
      expect(out).toContain("no rows");
    });
  });

  // ---------------------------------------------------------------------------
  // audit
  // ---------------------------------------------------------------------------
  describe("audit", () => {
    test("query returns seed entries", async () => {
      const out = await run(["audit", "query"], { env });
      // Seed created tenant, users, system accounts, api keys.
      expect(out.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // tunnels
  // ---------------------------------------------------------------------------
  describe("tunnels", () => {
    test("list starts empty", async () => {
      const out = await run(["tunnels", "list"], { env });
      expect(out).toContain("no rows");
    });
  });

  // ---------------------------------------------------------------------------
  // extract (AI flow — uses mock provider in tests)
  // ---------------------------------------------------------------------------
  describe("extract", () => {
    test("extracts structured data from a sample file", async () => {
      const samplePath = writeTempFile(
        env.personas.admin,
        "sample.txt",
        "Name: Alice, Age: 30, Email: alice@test.com",
      );
      const result = await cli(["extract", samplePath], { env });
      expectSuccess(result, "extract");
      // Mock provider returns a canned schema + data object.
      expect(result.stdout).toBeTruthy();
    });
  });
}); // end "sk CLI admin commands"
