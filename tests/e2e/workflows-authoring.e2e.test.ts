// Workflow authoring surface — create, validate, version, restore, audit.
//
// Drives the HTTP authoring contract (create → history → update → restore)
// plus the standalone validation utility, and proves the create writes an
// immutable audit row (workflow.created). Complements the conversation /
// mock-pinned authoring flows in authoring-regressions + guided-authoring
// (which own the inspect→validate→preview→commit tool loop) by pinning the
// plain REST authoring lifecycle.
//
// LLM: mock — boot hermetic; no model call on this REST path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { defaultTransformSteps, seedWorkflow } from "./_helpers/factories.ts";
import { apiClient } from "./_helpers/http.ts";
import { boot, cli, type E2EEnv, expectSuccess, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("workflows-authoring", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

describe("validation utility", () => {
  test("a structurally valid definition passes, a bad step kind fails with errors", async () => {
    const api = apiClient(env);
    const good = await api.post<{ ok: boolean }>("/v1/workflows/validate", {
      name: "validate-good",
      steps: defaultTransformSteps(),
    });
    expect(good.status).toBe(200);
    expect(good.body.ok).toBe(true);

    const bad = await api.post<{ ok: boolean; errors?: unknown[] }>("/v1/workflows/validate", {
      name: "validate-bad",
      steps: [{ id: "x", kind: "not-a-real-kind" }],
    });
    expect(bad.status).toBe(200);
    expect(bad.body.ok).toBe(false);
    expect((bad.body.errors ?? []).length).toBeGreaterThan(0);
  }, 30_000);
});

describe("create → history → update → restore", () => {
  test("authoring lifecycle versions correctly and is auditable", async () => {
    const api = apiClient(env);
    const { id, slug } = await seedWorkflow(env, { description: "v1" });

    // History has at least the initial version.
    const hist1 = await api.get<{ items?: unknown[] } | unknown[]>(`/v1/workflows/${id}/history`);
    expect(hist1.status).toBe(200);
    const versions1 = Array.isArray(hist1.body) ? hist1.body : (hist1.body.items ?? []);
    expect(versions1.length).toBeGreaterThanOrEqual(1);

    // Update produces a new version.
    const update = await api.put<{ id: string }>(`/v1/workflows/${id}`, {
      name: `Seed ${slug}`,
      slug,
      description: "v2",
      steps: [
        ...defaultTransformSteps(),
        {
          id: "second",
          kind: "transform",
          language: "javascript",
          expression: "return input.input;",
        },
      ],
    });
    expect([200, 201]).toContain(update.status);

    const hist2 = await api.get<{ items?: unknown[] } | unknown[]>(`/v1/workflows/${id}/history`);
    const versions2 = Array.isArray(hist2.body) ? hist2.body : (hist2.body.items ?? []);
    expect(versions2.length).toBeGreaterThan(versions1.length);

    // Restore the first version.
    const restore = await api.post(`/v1/workflows/${id}/restore/1`, {});
    expect([200, 201]).toContain(restore.status);

    // The create is in the audit trail.
    const audit = await api.get<unknown>("/v1/audit-log?limit=50");
    expect(audit.status).toBe(200);
    expect(JSON.stringify(audit.body)).toContain("workflow.created");
  }, 60_000);
});

describe("sk workflows CLI", () => {
  test("sk workflows list surfaces a seeded workflow", async () => {
    const { slug } = await seedWorkflow(env, { description: "cli visible" });
    const result = await cli(["workflows", "list"], { env, persona: "admin" });
    expectSuccess(result, "sk workflows list");
    expect(result.stdout).toContain(slug);
  }, 60_000);
});
