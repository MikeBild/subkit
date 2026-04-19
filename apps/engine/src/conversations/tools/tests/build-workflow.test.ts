// build_workflow tool tests.
//
// Cover:
//   - Happy path: draft is persisted with correct shape, persistence=draft_only
//   - Zod input validation errors yield invalid_input with issue list
//   - WorkflowDef schema errors surface as workflow_schema_invalid
//   - Unresolved connector slug → placeholder_connector_missing
//   - Unresolved credential field → placeholder_cred_missing
//   - input_schema inferred from sample when input_schema omitted
//   - Second call overwrites the draft (idempotency)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { upsertCredential } from "../../../credentials/service.ts";
import { connectors, tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import type { DraftDocument } from "../../types.ts";
import { buildWorkflowTool } from "../build-workflow.ts";
import type { ToolContext } from "../index.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("build_workflow");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-build", display_name: "T" })
    .returning();
  tenant_id = t!.id;
  // Seed a bearer connector and credential we can reference in placeholders.
  const [c] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "stripe",
      display_name: "Stripe",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://api.stripe.test",
      config: { region: "us" },
    })
    .returning();
  await upsertCredential(
    {
      tenant_id,
      connector_id: c!.id,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: "sk_test_xxx" },
      actor_id: null,
    },
    ctx.db,
  );
});

afterAll(async () => {
  await ctx.cleanup();
});

interface TestToolCtx extends ToolContext {
  /** Live accessor — reads the closure variable after each setDraft. */
  readonly draft: DraftDocument | null;
}

function makeCtx(overrides: Partial<ToolContext> = {}): TestToolCtx {
  const state: { draft: DraftDocument | null } = { draft: null };
  const base: ToolContext = {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(),
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => state.draft ?? { name: "", steps: [] },
    setDraft: async (next) => {
      state.draft = next;
    },
    ...overrides,
  };
  const result = base as TestToolCtx;
  Object.defineProperty(result, "draft", {
    configurable: true,
    enumerable: true,
    get: () => state.draft,
  });
  return result;
}

describe("build_workflow — happy path", () => {
  test("persists draft with persistence:draft_only", async () => {
    const toolCtx = makeCtx();
    const result = await buildWorkflowTool.execute(toolCtx, {
      name: "Stripe daily",
      slug: "stripe-daily",
      description: "Pulls today's Stripe customers",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          url: "${connector.stripe.base_url}/v1/customers",
          headers: { Authorization: "Bearer ${cred.stripe.token}" },
          query: { limit: "5" },
        },
      ],
      input_schema: { type: "object", properties: { since: { type: "string" } } },
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { persistence: string; draft: { slug: string; step_count: number } };
    expect(data.persistence).toBe("draft_only");
    expect(data.draft.slug).toBe("stripe-daily");
    expect(data.draft.step_count).toBe(1);
    expect(toolCtx.draft).not.toBeNull();
    expect(toolCtx.draft!.slug).toBe("stripe-daily");
    expect(toolCtx.draft!.steps).toHaveLength(1);
  });

  test("second call replaces the draft (idempotent)", async () => {
    const toolCtx = makeCtx();
    await buildWorkflowTool.execute(toolCtx, {
      name: "v1",
      slug: "v1",
      steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
      environment: "dev",
    });
    expect(toolCtx.draft!.slug).toBe("v1");
    await buildWorkflowTool.execute(toolCtx, {
      name: "v2",
      slug: "v2",
      steps: [
        { id: "a", kind: "wait", duration_ms: 200 },
        { id: "b", kind: "wait", duration_ms: 50 },
      ],
      environment: "dev",
    });
    expect(toolCtx.draft!.slug).toBe("v2");
    expect(toolCtx.draft!.steps).toHaveLength(2);
  });
});

describe("build_workflow — input shape errors", () => {
  test("bad slug shape → invalid_input", async () => {
    const toolCtx = makeCtx();
    const result = await buildWorkflowTool.execute(toolCtx, {
      name: "x",
      slug: "BAD SLUG!",
      steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
      environment: "dev",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as { error: { code: string } }).error;
    expect(err.code).toBe("invalid_input");
    expect(toolCtx.draft).toBeNull();
  });

  test("zero steps → invalid_input (min=1)", async () => {
    const toolCtx = makeCtx();
    const result = await buildWorkflowTool.execute(toolCtx, {
      name: "empty",
      slug: "empty",
      steps: [],
      environment: "dev",
    });
    expect(result.ok).toBe(false);
    expect((result.data as { error: { code: string } }).error.code).toBe("invalid_input");
  });
});

describe("build_workflow — workflow schema errors", () => {
  test("unknown step kind → workflow_schema_invalid", async () => {
    const toolCtx = makeCtx();
    const result = await buildWorkflowTool.execute(toolCtx, {
      name: "x",
      slug: "sv",
      steps: [{ id: "fail", kind: "magic", whatever: "ok" }],
      environment: "dev",
    });
    expect(result.ok).toBe(false);
    expect((result.data as { error: { code: string } }).error.code).toBe(
      "workflow_schema_invalid",
    );
    expect(toolCtx.draft).toBeNull();
  });
});

describe("build_workflow — placeholder integrity", () => {
  test("non-existent connector slug → placeholder_connector_missing", async () => {
    const toolCtx = makeCtx();
    const result = await buildWorkflowTool.execute(toolCtx, {
      name: "x",
      slug: "nope",
      steps: [
        {
          id: "s",
          kind: "request",
          method: "GET",
          url: "${connector.noslug.base_url}/x",
        },
      ],
      environment: "dev",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as {
      error: { code: string; details: { problems: Array<{ token: string; code: string }> } };
    }).error;
    expect(err.code).toBe("placeholder_connector_missing");
    expect(err.details.problems[0]!.token).toBe("${connector.noslug.base_url}");
  });

  test("missing credential field → placeholder_cred_missing", async () => {
    const toolCtx = makeCtx();
    const result = await buildWorkflowTool.execute(toolCtx, {
      name: "x",
      slug: "cred-miss",
      steps: [
        {
          id: "s",
          kind: "request",
          method: "GET",
          url: "${connector.stripe.base_url}/x",
          headers: { "x-hack": "${cred.stripe.nonexistent_field}" },
        },
      ],
      environment: "dev",
    });
    expect(result.ok).toBe(false);
    const err = (result.data as {
      error: { code: string; details: { problems: Array<{ token: string }> } };
    }).error;
    expect(err.code).toBe("placeholder_cred_missing");
    expect(err.details.problems[0]!.token).toBe("${cred.stripe.nonexistent_field}");
  });

  test("env mismatch: dev token requested from prod env → placeholder_connector_missing", async () => {
    const toolCtx = makeCtx();
    const result = await buildWorkflowTool.execute(toolCtx, {
      name: "x",
      slug: "env-miss",
      steps: [
        {
          id: "s",
          kind: "request",
          method: "GET",
          url: "${connector.stripe.base_url}/x",
        },
      ],
      environment: "prod",
    });
    expect(result.ok).toBe(false);
    expect((result.data as { error: { code: string } }).error.code).toBe(
      "placeholder_connector_missing",
    );
  });
});

describe("build_workflow — input_schema inference", () => {
  test("infers input_schema from input_schema_sample when input_schema omitted", async () => {
    const toolCtx = makeCtx();
    const result = await buildWorkflowTool.execute(toolCtx, {
      name: "inf",
      slug: "inf",
      steps: [{ id: "a", kind: "wait", duration_ms: 10 }],
      input_schema_sample: { since: "2026-04-01", limit: 50 },
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      draft: { input_schema_inferred: boolean };
      warnings: string[];
    };
    expect(data.draft.input_schema_inferred).toBe(true);
    expect(data.warnings).toContain("input_schema_inferred_from_sample");
    const inferred = (toolCtx.draft!.input_schema ?? {}) as Record<string, unknown>;
    expect(inferred.type).toBe("object");
  });

  test("explicit input_schema overrides sample", async () => {
    const toolCtx = makeCtx();
    const result = await buildWorkflowTool.execute(toolCtx, {
      name: "x",
      slug: "override",
      steps: [{ id: "a", kind: "wait", duration_ms: 10 }],
      input_schema: { type: "object", required: ["custom"] },
      input_schema_sample: { foo: 1 },
      environment: "dev",
    });
    expect(result.ok).toBe(true);
    const data = result.data as { draft: { input_schema_inferred: boolean } };
    expect(data.draft.input_schema_inferred).toBe(false);
    expect((toolCtx.draft!.input_schema as { required: string[] }).required).toEqual([
      "custom",
    ]);
  });
});
