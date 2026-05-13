// Authoring-critic — integration with build_workflow.
//
// Covers the rejected-by-critic path end-to-end:
//   - Runtime config enables the critic (no env var feature flags).
//   - Mock provider canned to return `{passed:false, repairs:[...]}`.
//   - build_workflow returns ok:false {error_code:"critic_rejected"}.
//   - The draft is NOT persisted (setDraft never fires).
//   - A usage row is written under flow="critic_authoring".
//   - Anti-loop: ≥ max_consecutive_rejections short-circuits.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import {
  auditLog,
  connectors,
  conversations,
  conversationToolCalls,
  llmUsage,
  tenants,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { getMetrics } from "../../observability/metrics.ts";
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
  // Bootstrap config with `LLM_PROVIDER=mock` so the provider registry
  // selects the in-process mock. This is the *bootstrap* env channel
  // documented in env.ts, not a feature flag — the critic itself is
  // gated only by runtime config.
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-critic-int-"));
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/critic-int",
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
    },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

async function enableCritic(opts: { maxConsecutiveRejections?: number } = {}): Promise<void> {
  await setConfigKey(["llm", "critic", "enabled"], true);
  await setConfigKey(["llm", "critic", "min_steps"], 3);
  await setConfigKey(
    ["llm", "critic", "max_consecutive_rejections"],
    opts.maxConsecutiveRejections ?? 3,
  );
}

async function disableCritic(): Promise<void> {
  await setConfigKey(["llm", "critic", "enabled"], false);
}

beforeAll(async () => {
  await ensureConfigLoaded();
  testDb = await createTestDb("critic_integration");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-critic", display_name: "T-critic" })
    .returning();
  tenant_id = t!.id;
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
  // Always restore the disabled default — neighbouring suites in the
  // same Bun process must not inherit a hot critic.
  await disableCritic();
  await testDb.cleanup();
});

beforeEach(() => {
  resetMockProvider();
});

interface TestCtxWithDraft extends ToolContext {
  readonly draft: DraftDocument | null;
}

async function seedConversation(conversation_id: string): Promise<void> {
  await testDb.db
    .insert(conversations)
    .values({ id: conversation_id, tenant_id, title: "critic test", status: "active" })
    .onConflictDoNothing();
}

/**
 * Synthesize an empty draft whose `latest_preview` is pre-seeded with
 * step_traces for the three IDs the test fixtures
 * (`threeStepDraftArgs`, the 2-step variants below) use.
 *
 * The critic-integration tests are exercising critic verdict handling,
 * not the v4.8.0 transform-authoring gate. In production a build_workflow
 * call that introduces transforms reading from `$scope.<X>` would not
 * have reached the critic without a prior `dry_run_workflow` recording
 * X's preview — the gate enforces exactly that. We replicate the
 * realistic state here so the critic layer is what's under test, not
 * the gate above it.
 */
function makeDraftWithPreviewSeed(): DraftDocument {
  const empty = createEmptyDraftDocument();
  return {
    ...empty,
    latest_preview: {
      ok: true,
      summary: "critic-integration test fixture (seeded preview for fetch/shape/tag)",
      step_traces: [
        { step_id: "fetch", kind: "request", status: "succeeded", output_preview: { items: [] } },
        {
          step_id: "shape",
          kind: "transform",
          status: "succeeded",
          output_preview: [{ id: "x" }],
        },
        {
          step_id: "tag",
          kind: "transform",
          status: "succeeded",
          output_preview: [{ id: "x", tag: "ok" }],
        },
      ],
    },
  };
}

function makeCtx(conversation_id?: string): TestCtxWithDraft {
  const state: { draft: DraftDocument | null } = { draft: null };
  const base: ToolContext = {
    db: testDb.db,
    tenant_id,
    conversation_id: conversation_id ?? crypto.randomUUID(), // allow-random: tests
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: testDb.db }),
    getDraft: () => state.draft ?? makeDraftWithPreviewSeed(),
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
    await enableCritic();
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
    expect(ctx.draft).toBeNull();
  });

  test("critic records a usage row tagged flow=critic_authoring", async () => {
    await enableCritic();
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

  test("anti-loop: after N consecutive rejections the critic stops running", async () => {
    // Lower the cap so the test doesn't have to spin five times.
    await enableCritic({ maxConsecutiveRejections: 2 });
    getMockProvider().generateOverrides.critic_authoring = () => ({
      passed: false,
      repairs: ["fix"],
      rationale: "still bad",
    });

    const conversation_id = crypto.randomUUID(); // allow-random: tests
    await seedConversation(conversation_id);

    // Pre-seed two prior `critic_rejected` tool-call rows so the
    // third invocation hits the anti-loop cap. The build_workflow tool
    // scans conversationToolCalls; we don't need the rows to be
    // real build outputs — only `tool` + `output.error_code` matter.
    for (let i = 0; i < 2; i++) {
      await testDb.db.insert(conversationToolCalls).values({
        tenant_id,
        conversation_id,
        tool: "build_workflow",
        input: {},
        output: { ok: false, error_code: "critic_rejected" },
      });
    }

    const ctx = makeCtx(conversation_id);
    const result = await buildWorkflowTool.execute(ctx, threeStepDraftArgs());
    // Critic skipped → draft proceeds normally to setDraft.
    expect(result.ok).toBe(true);
    expect(ctx.draft).not.toBeNull();
  });
});

describe("build_workflow + authoring-critic — gated off", () => {
  test("config llm.critic.enabled=false → no critic call, draft persists normally", async () => {
    await disableCritic();
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

  test("two-step draft + no recent drift → critic skipped even when enabled", async () => {
    await enableCritic();
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
    await enableCritic();
    // Default mock returns passed:true.
    const ctx = makeCtx();
    const result = await buildWorkflowTool.execute(ctx, threeStepDraftArgs());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { infos: string[] };
    expect(data.infos.some((i) => i.startsWith("critic_passed:"))).toBe(true);
  });
});

describe("build_workflow + authoring-critic — replay-determinism", () => {
  test("two identical runs against the same canned plan produce byte-identical tool payloads", async () => {
    await enableCritic();
    const canned = () => ({
      passed: false,
      repairs: ["fix the third step", "drop the redundant transform"],
      rationale: "duplicate projection",
    });
    getMockProvider().generateOverrides.critic_authoring = canned;

    const ctx1 = makeCtx();
    const r1 = await buildWorkflowTool.execute(ctx1, threeStepDraftArgs());

    resetMockProvider();
    getMockProvider().generateOverrides.critic_authoring = canned;

    const ctx2 = makeCtx();
    const r2 = await buildWorkflowTool.execute(ctx2, threeStepDraftArgs());

    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });
});

describe("build_workflow + authoring-critic — audit trail", () => {
  test("each critic invocation writes an LLM_INVOCATION audit row tagged flow=critic_authoring", async () => {
    await enableCritic();
    getMockProvider().generateOverrides.critic_authoring = () => ({
      passed: false,
      repairs: ["fix"],
      rationale: "audit test",
    });

    const ctx = makeCtx();
    await buildWorkflowTool.execute(ctx, threeStepDraftArgs());

    const rows = await testDb.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.action, "llm.invocation")));
    const criticAudits = rows.filter(
      (r) => (r.metadata as { flow?: string } | null)?.flow === "critic_authoring",
    );
    expect(criticAudits.length).toBeGreaterThanOrEqual(1);
    const sample = criticAudits[criticAudits.length - 1]!;
    expect(sample.result).toBe("success");
    expect((sample.metadata as { provider?: string }).provider).toBe("mock");
  });
});

describe("build_workflow + authoring-critic — cross-tenant isolation", () => {
  test("anti-loop counter is tenant-scoped — tenant B's rejections do not gate tenant A", async () => {
    await enableCritic({ maxConsecutiveRejections: 2 });
    getMockProvider().generateOverrides.critic_authoring = () => ({
      passed: false,
      repairs: ["fix"],
      rationale: "different tenant",
    });

    // Seed a SECOND tenant (B) with two critic_rejected rows. If the
    // counter scan ever drops the tenant_id predicate, tenant A's gate
    // will see consecutiveRejections=2 from B's rows and skip the critic
    // when it shouldn't.
    const [tenantB] = await testDb.db
      .insert(tenants)
      .values({ slug: "t-critic-b", display_name: "T-critic-B" })
      .returning();
    const tenant_b_id = tenantB!.id;
    const conv_b = crypto.randomUUID(); // allow-random: tests
    await testDb.db
      .insert(conversations)
      .values({ id: conv_b, tenant_id: tenant_b_id, title: "B convo", status: "active" });
    for (let i = 0; i < 2; i++) {
      await testDb.db.insert(conversationToolCalls).values({
        tenant_id: tenant_b_id,
        conversation_id: conv_b,
        tool: "build_workflow",
        input: {},
        output: { ok: false, error_code: "critic_rejected" },
      });
    }

    // Now run as tenant A (the seeded `tenant_id`) — anti-loop must
    // NOT trip because A has zero recent rejections.
    const ctx = makeCtx();
    const result = await buildWorkflowTool.execute(ctx, threeStepDraftArgs());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error_code).toBe("critic_rejected");
  });
});

describe("build_workflow + authoring-critic — metrics", () => {
  test("subkit_critic_runs_total{result=rejected} is incremented on a rejected verdict", async () => {
    await enableCritic();
    getMockProvider().generateOverrides.critic_authoring = () => ({
      passed: false,
      repairs: ["fix"],
      rationale: "metric test",
    });

    const ctx = makeCtx();
    await buildWorkflowTool.execute(ctx, threeStepDraftArgs());

    const snapshot = getMetrics().snapshot();
    const counter = snapshot.find((s) => s.name === "subkit_critic_runs_total");
    expect(counter).toBeDefined();
    const rejectedSamples = counter!.samples.filter((s) => s.labels.result === "rejected");
    expect(rejectedSamples.length).toBeGreaterThanOrEqual(1);
    expect(rejectedSamples.reduce((sum, s) => sum + s.value, 0)).toBeGreaterThanOrEqual(1);
  });
});
