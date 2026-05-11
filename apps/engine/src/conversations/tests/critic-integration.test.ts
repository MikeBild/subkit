// Authoring-critic — integration with build_workflow.
//
// Covers the rejected-by-critic path end-to-end:
//   - CRITIC_ENABLED=true gates on, 3+ steps satisfies the step-count rule.
//   - Mock provider canned to return `{passed:false, repairs:[...]}`.
//   - build_workflow returns ok:false {error_code:"critic_rejected"}.
//   - The draft is NOT persisted (setDraft never fires).
//   - A usage row is written under flow="critic_authoring".

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getConfig, loadConfig } from "../../config/loader.ts";
import { connectors, llmUsage, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import { buildWorkflowTool } from "../tools/build-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

let testDb: TestDb;
let tenant_id: string;

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    /* fall through */
  }
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-critic-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/critic-test", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  await ensureConfigLoaded();
  testDb = await createTestDb("critic_integration");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-critic", display_name: "T-critic" })
    .returning();
  tenant_id = t!.id;
  // Seed a no-auth connector so the steps that reference its slug pass
  // the placeholder gate even though they use a fully-qualified URL.
  await testDb.db
    .insert(connectors)
    .values({
      tenant_id,
      slug: "demo",
      display_name: "Demo",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: "https://demo.test",
      config: {},
    })
    .returning();
});

afterAll(async () => {
  await testDb.cleanup();
});

beforeEach(() => {
  resetMockProvider();
  process.env.CRITIC_ENABLED = "true";
});

afterEach(() => {
  delete process.env.CRITIC_ENABLED;
  delete process.env.CRITIC_MIN_STEPS;
});

interface TestCtxWithDraft extends ToolContext {
  readonly draft: DraftDocument | null;
}

function makeCtx(): TestCtxWithDraft {
  const state: { draft: DraftDocument | null } = { draft: null };
  const base: ToolContext = {
    db: testDb.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: tests
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: testDb.db }),
    getDraft: () => state.draft ?? createEmptyDraftDocument(),
    setDraft: async (next) => {
      state.draft = next;
    },
  };
  Object.defineProperty(base, "draft", {
    configurable: true,
    enumerable: true,
    get: () => state.draft,
  });
  return base as TestCtxWithDraft;
}

function threeStepDraftArgs() {
  return {
    name: "Three-step demo",
    slug: "three-step-demo",
    steps: [
      {
        id: "fetch",
        kind: "request" as const,
        method: "GET",
        url: "https://demo.test/v1/items",
      },
      {
        id: "shape",
        kind: "transform" as const,
        expression: "$scope.fetch.data.items",
        language: "jsonata" as const,
      },
      {
        id: "tag",
        kind: "transform" as const,
        expression: "$scope.shape.data",
        language: "jsonata" as const,
      },
    ],
    environment: "dev" as const,
  };
}

describe("build_workflow + authoring-critic — rejected path", () => {
  test("failed critic returns ok:false with critic_rejected and does NOT persist draft", async () => {
    getMockProvider().generateOverrides.critic_authoring = () => ({
      passed: false,
      repairs: [
        "Step `tag` reads `$scope.shape.data` but `shape` returns an array of items, not an object",
        "Drop the redundant second transform — the first already produces the final shape",
      ],
      rationale:
        "The third step duplicates the second's projection and reads an envelope field that does not exist.",
    });

    const ctx = makeCtx();
    const result = await buildWorkflowTool.execute(ctx, threeStepDraftArgs());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("critic_rejected");
    expect(result.message).toContain("LLM critic found 2 issue(s)");
    expect(result.next_best_actions).toContain("inspect_workflow_draft");
    const details = result.details as { repairs: string[]; rationale: string };
    expect(details.repairs).toHaveLength(2);
    expect(details.repairs[0]).toContain("Step `tag`");
    expect(details.rationale).toContain("third step");
    // Draft must NOT have been persisted.
    expect(ctx.draft).toBeNull();
  });

  test("critic records a usage row tagged flow=critic_authoring", async () => {
    getMockProvider().generateOverrides.critic_authoring = () => ({
      passed: false,
      repairs: ["fix it"],
      rationale: "broken",
    });

    const ctx = makeCtx();
    await buildWorkflowTool.execute(ctx, threeStepDraftArgs());

    const rows = await testDb.db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, tenant_id), eq(llmUsage.flow, "critic_authoring")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const last = rows[rows.length - 1]!;
    expect(last.result).toBe("success");
    expect(last.completion_tokens).toBeGreaterThan(0);
  });
});

describe("build_workflow + authoring-critic — gated off", () => {
  test("CRITIC_ENABLED unset → no critic call, draft persists normally", async () => {
    delete process.env.CRITIC_ENABLED;
    // If the gating were broken and the critic fired, this override would
    // make it return passed:false — so a persisted draft proves gating.
    getMockProvider().generateOverrides.critic_authoring = () => ({
      passed: false,
      repairs: ["should not be applied"],
      rationale: "gated off",
    });

    const ctx = makeCtx();
    const result = await buildWorkflowTool.execute(ctx, threeStepDraftArgs());

    expect(result.ok).toBe(true);
    expect(ctx.draft).not.toBeNull();
    expect(ctx.draft!.workflow?.slug).toBe("three-step-demo");
  });

  test("two-step draft + no recent drift → critic skipped even with CRITIC_ENABLED", async () => {
    process.env.CRITIC_ENABLED = "true";
    getMockProvider().generateOverrides.critic_authoring = () => ({
      passed: false,
      repairs: ["should not fire"],
      rationale: "should not fire",
    });

    const ctx = makeCtx();
    const result = await buildWorkflowTool.execute(ctx, {
      name: "Two-step",
      slug: "two-step",
      steps: [
        {
          id: "fetch",
          kind: "request" as const,
          method: "GET",
          url: "https://demo.test/v1/items",
        },
        {
          id: "shape",
          kind: "transform" as const,
          expression: "$scope.fetch.data.items",
          language: "jsonata" as const,
        },
      ],
      environment: "dev" as const,
    });

    expect(result.ok).toBe(true);
    expect(ctx.draft).not.toBeNull();
  });
});

describe("build_workflow + authoring-critic — passed path", () => {
  test("critic passes → success payload carries critic_passed info tag", async () => {
    // Default mock returns passed:true.
    const ctx = makeCtx();
    const result = await buildWorkflowTool.execute(ctx, threeStepDraftArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { infos: string[] };
    expect(data.infos.some((i) => i.startsWith("critic_passed:"))).toBe(true);
  });
});
