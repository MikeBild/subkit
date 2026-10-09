import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { callerFromPrincipal } from "../../execution/caller-context.ts";
import { runExecution } from "../../execution/engine.ts";
import { LLM_CALL_TIMEOUT_MS } from "../../llm/core/ai-sdk-model.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { recordSuccessShape } from "../../schema-versions/service.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { withDriverFetchForTests } from "../../test-helpers/driver-fetch.ts";
import type { WorkflowTrigger } from "../../workflows/types.ts";
import {
  GeneratedWorkflowSchema,
  MAX_GENERATION_PASSES,
  PIPELINE_DEADLINE_MS,
  runAuthoringPipeline,
} from "../authoring-pipeline.ts";
import { createEmptyDraftDocument } from "../authoring-state.ts";
import type { RecordedEvalReport } from "../recorded-eval.ts";
import { authorWorkflowTool } from "../tools/author-workflow.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

const nextUuid = createDeterministicUuidFactory(0xa07_40);

let ctx: TestDb;
let tenant_id: string;

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-authoring-pipeline-"));
  await loadConfig({
    env: {
      DATABASE_URL: "postgres://placeholder/authoring-pipeline",
      NODE_ENV: "test",
      LLM_PROVIDER: "mock",
    },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

let fetchCalls = 0;

const tripwire = ((..._args: unknown[]) => {
  fetchCalls += 1;
  throw new Error("live HTTP is forbidden inside the authoring pipeline");
}) as unknown as typeof fetch;

function tw(name: string, body: () => Promise<void>) {
  test(name, () => withDriverFetchForTests(tripwire, body));
}

beforeAll(async () => {
  await ensureConfigLoaded();
  ctx = await createTestDb("authoring_pipeline");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-author-pipeline", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

beforeEach(() => {
  resetMockProvider();
  fetchCalls = 0;
});

function makeCtx(): ToolContext & { _draft: { value: DraftDocument | null } } {
  const ref: { value: DraftDocument | null } = { value: null };
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: nextUuid(),
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => ref.value ?? createEmptyDraftDocument(),
    setDraft: async (d) => {
      ref.value = d;
    },
    _draft: ref,
  };
}

const VALID_DEF = {
  name: "Top repos digest",
  slug: "top-repos-digest",
  description: "Fetch repos and shape the top entries.",
  steps: [
    {
      id: "fetch_repos",
      kind: "request",
      method: "GET",
      url: "https://jsonplaceholder.typicode.com/posts",
    },
    {
      id: "shape_repos",
      kind: "transform",
      language: "javascript",
      expression:
        "const repos = input.scope.fetch_repos.data; return repos.map(r => ({ name: r.name }));",
    },
  ],
  output_schema: { type: "array" },
};

const NEVER_VALID_DEF = {
  name: "Broken loop",
  slug: "broken-loop",
  steps: [
    {
      id: "fetch",
      kind: "request",
      method: "GET",
      url: "https://jsonplaceholder.typicode.com/todos",
    },
    { id: "iter", kind: "loop", over: "$scope.fetch.data", body: ["missing_step"] },
  ],
};

describe("runAuthoringPipeline — one-shot contract", () => {
  tw(
    "scripted caller workflow authors once and runs with exact authenticated types and zero egress",
    async () => {
      const definition = {
        name: "Observe trusted caller",
        slug: "observe-trusted-caller",
        required_caller_kind: "user",
        steps: [
          {
            id: "identity",
            kind: "transform",
            language: "javascript",
            expression:
              "const caller = input.scope.$caller; if (!caller) return null; return caller;",
          },
        ],
      };
      const principal = {
        provider: "test",
        kind: "user" as const,
        id: nextUuid(),
        tenant_id,
        roles: ["admin"],
      };
      getMockProvider().generateOverrides.generate = () => definition;
      const toolCtx = { ...makeCtx(), principal };
      const authored = await runAuthoringPipeline({
        ctx: toolCtx,
        goal: "Return the authenticated caller; ignore caller-shaped user input.",
      });
      expect(authored.ok).toBe(true);
      if (!authored.ok) throw new Error("caller authoring failed");
      expect(authored.attempts).toBe(1);
      expect(authored.validation.ok).toBe(true);
      expect(getMockProvider().calls.filter((call) => call.flow === "generate")).toHaveLength(1);
      const run = await runExecution({
        db: ctx.db,
        tenant_id,
        source: { kind: "draft", definition: authored.definition },
        input: { caller: { principalId: "spoofed-owner", productId: "spoofed-product" } },
        options: { principal },
      });
      expect(run.status).toBe("succeeded");
      expect(run.steps).toHaveLength(1);
      expect(run.output).toEqual(callerFromPrincipal(principal, tenant_id));
      expect(run.output).toMatchObject({
        tenantId: tenant_id,
        principalId: principal.id,
        principalKind: "user",
        provider: "test",
        productId: null,
      });
      expect(Object.keys(run.output as object).sort()).toEqual([
        "principalId",
        "principalKind",
        "productId",
        "provider",
        "tenantId",
      ]);
      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "generated product and sensitive headers survive authoring and cannot downgrade a chat preview",
    async () => {
      const headers = {
        product_id: "harmoniqs",
        required_caller_kind: "user",
        execution_privacy: "sensitive",
      };
      getMockProvider().generateOverrides.generate = () => ({
        name: "Private caller workflow",
        slug: "private-caller-workflow",
        ...headers,
        steps: [
          {
            id: "identity",
            kind: "transform",
            language: "javascript",
            expression: "return input.scope.$caller ?? null;",
          },
        ],
      });
      const principal = {
        provider: "test",
        kind: "user" as const,
        id: nextUuid(),
        tenant_id,
        roles: ["admin"],
      };
      const toolCtx = { ...makeCtx(), principal };
      const authored = await runAuthoringPipeline({
        ctx: toolCtx,
        goal: "Prepare a sensitive product user workflow without running it in chat.",
      });
      expect(authored.ok).toBe(true);
      if (!authored.ok) throw new Error("private authoring failed");
      expect(authored.definition).toMatchObject(headers);
      expect(toolCtx.getDraft().workflow).toMatchObject(headers);
      const initial = JSON.stringify(toolCtx.getDraft());
      let writes = 0;
      toolCtx.setDraft = async () => {
        writes++;
      };
      const preview = await dryRunWorkflowTool.execute(toolCtx, {
        input: { secret: "private-input-canary" },
      });
      expect(preview).toMatchObject({ ok: false, error_code: "sensitive_execution_unsupported" });
      expect(JSON.stringify(preview)).not.toContain("private-input-canary");
      expect(writes).toBe(0);
      expect(JSON.stringify(toolCtx.getDraft())).toBe(initial);
      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "emits a schema-valid complete definition with recorded_eval attached, goal stashed, JS transform preserved, zero egress",
    async () => {
      getMockProvider().generateOverrides.generate = () => VALID_DEF;
      const toolCtx = makeCtx();
      const goal = "Show me the top repos with their names";
      const result = await runAuthoringPipeline({ ctx: toolCtx, goal });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.attempts).toBe(1);
      expect(result.next).toBe("dry_run_workflow");
      expect(result.validation.ok).toBe(true);
      expect(result.definition.slug).toBe("top-repos-digest");
      const transform = result.definition.steps.find((s) => s.kind === "transform");
      expect(transform?.language).toBe("javascript");
      expect(
        result.recorded_eval.expressions.filter((f) => f.status === "compile_error"),
      ).toHaveLength(0);

      const draft = toolCtx._draft.value;
      expect(draft).not.toBeNull();
      expect((draft!.workflow as { goal?: string }).goal).toBe(goal);
      expect(draft?.workflow.slug).toBe("top-repos-digest");
      expect(draft?.workflow.steps).toHaveLength(2);

      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "regenerate path: one structural failure earns exactly ONE more pass with the findings appended",
    async () => {
      let calls = 0;
      getMockProvider().generateOverrides.generate = () => {
        calls += 1;
        return calls === 1 ? NEVER_VALID_DEF : VALID_DEF;
      };
      const toolCtx = makeCtx();
      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "digest the repos" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.attempts).toBe(2);
      expect(result.validation.ok).toBe(true);
      expect(calls).toBe(2);
      const generateCalls = getMockProvider().calls.filter((c) => c.flow === "generate");
      expect(generateCalls).toHaveLength(2);
      expect(generateCalls[1]?.last_user).toContain("Findings from the previous attempt");
      expect(generateCalls[1]?.last_user).toContain("missing_step");
      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "never-converging mock gives up after MAX_GENERATION_PASSES with authoring_definition_invalid and the previous draft untouched",
    async () => {
      let calls = 0;
      getMockProvider().generateOverrides.generate = () => {
        calls += 1;
        return NEVER_VALID_DEF;
      };
      const toolCtx = makeCtx();
      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "loop the things" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error_code).toBe("authoring_definition_invalid");
      expect(calls).toBe(MAX_GENERATION_PASSES);
      expect(result.attempts).toBe(MAX_GENERATION_PASSES);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.message).toContain("not stored as the draft");
      expect(toolCtx._draft.value).toBeNull();
      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "a generated definition that fails the workflow schema is refused by author_workflow and never becomes the draft",
    async () => {
      getMockProvider().generateOverrides.generate = () => ({
        name: "Schema broken",
        slug: "schema-broken",
        steps: [
          {
            id: "fetch",
            kind: "request",
            method: "GET",
            url: "https://jsonplaceholder.typicode.com/todos",
          },
          { id: "branch", kind: "branch", when: "true" },
          {
            id: "call",
            kind: "request",
            method: "GET",
            connector_id: "not-a-uuid",
            path: "/items",
          },
        ],
      });
      const toolCtx = makeCtx();
      const before = createEmptyDraftDocument();
      before.workflow = {
        name: "Kept",
        slug: "kept",
        steps: [{ id: "a", kind: "transform", language: "javascript", expression: "return 1;" }],
      };
      toolCtx._draft.value = before;
      const result = await authorWorkflowTool.execute(toolCtx, { goal: "branch on the items" });
      expect(result.ok).toBe(false);
      const data = result.data as { error_code: string; next_best_actions: string[] };
      expect(data.error_code).toBe("authoring_definition_invalid");
      expect(data.next_best_actions).toEqual(["author_workflow"]);
      expect(toolCtx._draft.value?.workflow.slug).toBe("kept");
      expect(fetchCalls).toBe(0);
    },
  );

  tw("a later pass that comes back invalid never throws away an earlier valid draft", async () => {
    try {
      await setConfigKey(["llm", "critic", "enabled"], true);
      await setConfigKey(["llm", "critic", "min_steps"], 2);
      let calls = 0;
      getMockProvider().generateOverrides.generate = () => {
        calls += 1;
        return calls === 1 ? VALID_DEF : NEVER_VALID_DEF;
      };
      getMockProvider().generateOverrides.critic_authoring = () => ({
        passed: false,
        repairs: ["Reorder shape_repos before fetch_repos consumes it"],
        rationale: "step order drift",
      });
      const toolCtx = makeCtx();
      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "digest the repos" });
      expect(calls).toBe(2);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.definition.slug).toBe("top-repos-digest");
      expect(result.validation.ok).toBe(true);
      expect(toolCtx._draft.value?.workflow.slug).toBe("top-repos-digest");
      expect(fetchCalls).toBe(0);
    } finally {
      await setConfigKey(["llm", "critic", "enabled"], false);
      await setConfigKey(["llm", "critic", "min_steps"], 3);
    }
  });

  tw(
    "schema-unparseable output on every pass yields authoring_generation_failed with nothing stashed",
    async () => {
      getMockProvider().generateOverrides.generate = () => ({ nope: true });
      const toolCtx = makeCtx();
      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "impossible" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error_code).toBe("authoring_generation_failed");
      expect(result.attempts).toBe(MAX_GENERATION_PASSES);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.deadline_exceeded).toBeUndefined();
      expect(result.message).toContain("schema-parseable");
      expect(toolCtx._draft.value).toBeNull();
      expect(fetchCalls).toBe(0);
    },
  );
});

describe("runAuthoringPipeline — grounding", () => {
  tw(
    "the ONE generation prompt carries the goal verbatim, the connector, its recorded endpoint samples, and the verbatim JS contract",
    async () => {
      const [connector] = await ctx.db
        .insert(connectors)
        .values({
          tenant_id,
          slug: "examplehub",
          display_name: "ExampleHub",
          driver: "http",
          base_url: "https://api.examplehub.test",
          auth_type: "bearer",
        })
        .returning();
      await recordSuccessShape(
        {
          tenant_id,
          connector_id: connector!.id,
          endpoint_key: "GET /v1/widgets",
          value: { widgets: [{ id: 1, name: "w" }] },
        },
        ctx.db,
      );

      getMockProvider().generateOverrides.generate = () => VALID_DEF;
      const toolCtx = makeCtx();
      const goal = "List every widget from ExampleHub with its name";
      const result = await runAuthoringPipeline({
        ctx: toolCtx,
        goal,
        connector_ids: ["examplehub"],
      });
      expect(result.ok).toBe(true);

      const generateCall = getMockProvider().calls.find((c) => c.flow === "generate");
      expect(generateCall).toBeDefined();
      const prompt = generateCall!.last_user;
      expect(prompt).toContain(goal);
      expect(prompt).toContain("examplehub");
      expect(prompt).toContain(connector!.id);
      expect(prompt).toContain("auth bearer");
      expect(prompt).toContain("Recorded endpoint samples");
      expect(prompt).toContain("GET /v1/widgets");
      expect(prompt).toContain("FUNCTION BODY");
      expect(prompt).toContain("input.scope.<step_id>.data");
      expect(prompt).toContain("input.input");
      expect(prompt).toContain('language: "javascript"');
      expect(prompt).toContain("ONE bulk list endpoint over a nested per-item loop");
      expect(prompt).toContain("`item_var` is retired");
      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "all named connectors unresolved → fail fast, no ungrounded generation, nothing stashed",
    async () => {
      let generateCalls = 0;
      getMockProvider().generateOverrides.generate = () => {
        generateCalls += 1;
        return VALID_DEF;
      };
      const toolCtx = makeCtx();
      const result = await runAuthoringPipeline({
        ctx: toolCtx,
        goal: "anything",
        connector_ids: ["no-such-connector"],
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error_code).toBe("authoring_connectors_unresolved");
      expect(result.unresolved_connectors).toEqual(["no-such-connector"]);
      expect(generateCalls).toBe(0);
      expect(toolCtx._draft.value).toBeNull();
    },
  );

  tw("partial connector resolution proceeds and reports the misses", async () => {
    getMockProvider().generateOverrides.generate = () => VALID_DEF;
    const toolCtx = makeCtx();
    const result = await runAuthoringPipeline({
      ctx: toolCtx,
      goal: "list every widget",
      connector_ids: ["examplehub", "no-such-connector"],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.unresolved_connectors).toEqual(["no-such-connector"]);
  });
});

describe("GeneratedWorkflowSchema — step breadth bound (P2)", () => {
  test("rejects a definition with more than 25 steps", () => {
    const steps = Array.from({ length: 26 }, (_, i) => ({
      id: `s_${i}`,
      kind: "transform",
      language: "javascript",
      expression: "return input.input;",
    }));
    const parsed = GeneratedWorkflowSchema.safeParse({
      name: "too wide",
      slug: "too-wide",
      steps,
    });
    expect(parsed.success).toBe(false);
  });

  test("accepts a definition at the 25-step bound", () => {
    const steps = Array.from({ length: 25 }, (_, i) => ({
      id: `s_${i}`,
      kind: "transform",
      language: "javascript",
      expression: "return input.input;",
    }));
    const parsed = GeneratedWorkflowSchema.safeParse({
      name: "at bound",
      slug: "at-bound",
      steps,
    });
    expect(parsed.success).toBe(true);
  });

  test("accepts workflow-level governance and runtime fields", () => {
    const parsed = GeneratedWorkflowSchema.safeParse({
      name: "budgeted",
      slug: "budgeted",
      max_llm_tokens_per_run: 70_000,
      timeout_ms: 120_000,
      validation_function: "return input.ok === true;",
      runtime: { stdlib_version: "1" },
      steps: [{ id: "a", kind: "wait", duration_ms: 100 }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe("runAuthoringPipeline — shared deadline / abort degradation (P2)", () => {
  tw(
    "a deadline/turn abort after an invalid pass refuses with deadline_exceeded and stashes nothing, no hang",
    async () => {
      const controller = new AbortController();
      let calls = 0;
      getMockProvider().generateOverrides.generate = () => {
        calls += 1;
        if (calls === 1) {
          controller.abort();
          return NEVER_VALID_DEF;
        }
        return VALID_DEF;
      };

      const toolCtx = makeCtx();
      (toolCtx as { abortSignal?: AbortSignal }).abortSignal = controller.signal;

      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "abort me" });

      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(calls).toBe(1);
      expect(result.attempts).toBe(1);
      expect(result.error_code).toBe("authoring_definition_invalid");
      expect(result.deadline_exceeded).toBe(true);
      expect(toolCtx._draft.value).toBeNull();
      expect(fetchCalls).toBe(0);
    },
  );

  tw("a pre-aborted turn signal returns a typed failure, never hangs", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.generate = () => {
      calls += 1;
      return VALID_DEF;
    };
    const toolCtx = makeCtx();
    (toolCtx as { abortSignal?: AbortSignal }).abortSignal = AbortSignal.abort();

    const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "already aborted" });

    expect(calls).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error_code).toBe("authoring_generation_failed");
    expect(result.deadline_exceeded).toBe(true);
    expect(result.message).toContain("ran out of time");
    expect(result.message).not.toContain("schema-parseable");
    expect(toolCtx._draft.value).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  test("the pipeline budget can fund every pass it promises", () => {
    expect(PIPELINE_DEADLINE_MS).toBeGreaterThanOrEqual(
      MAX_GENERATION_PASSES * LLM_CALL_TIMEOUT_MS,
    );
    expect(
      PIPELINE_DEADLINE_MS - MAX_GENERATION_PASSES * LLM_CALL_TIMEOUT_MS,
    ).toBeGreaterThanOrEqual(LLM_CALL_TIMEOUT_MS);
    expect(PIPELINE_DEADLINE_MS).toBeLessThan(10 * 60_000);
  });
});

describe("author_workflow — tool envelope", () => {
  tw(
    "returns the evaluated draft payload with recorded_eval + next_step and stashes the goal",
    async () => {
      getMockProvider().generateOverrides.generate = () => VALID_DEF;
      const toolCtx = makeCtx();
      const result = await authorWorkflowTool.execute(toolCtx, {
        goal: "Show me the top repos with their names",
      });
      expect(result.ok).toBe(true);
      const data = result.data as {
        recorded_eval: RecordedEvalReport;
        next_step: string;
        attempts: number;
        definition: { slug: string };
        persistence: string;
      };
      expect(data.next_step).toBe("dry_run_workflow");
      expect(data.attempts).toBe(1);
      expect(data.definition.slug).toBe("top-repos-digest");
      expect(data.persistence).toBe("draft_only");
      expect(data.recorded_eval).toBeDefined();
      expect((toolCtx._draft.value!.workflow as { goal?: string }).goal).toBe(
        "Show me the top repos with their names",
      );
      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "explicit identity is retained before preview even when generation chooses another name",
    async () => {
      getMockProvider().generateOverrides.generate = () => structuredClone(VALID_DEF);
      const toolCtx = makeCtx();
      const result = await authorWorkflowTool.execute(toolCtx, {
        goal: "Prepare the requested workflow",
        name: "Requested report",
        slug: "requested-report",
      });
      expect(result.ok).toBe(true);
      expect(result.data).toMatchObject({
        definition: { name: "Requested report", slug: "requested-report" },
        workflow: { name: "Requested report", slug: "requested-report" },
        persistence: "draft_only",
      });
      expect(toolCtx.getDraft().workflow).toMatchObject({
        name: "Requested report",
        slug: "requested-report",
      });
      expect(fetchCalls).toBe(0);
    },
  );

  tw("generation failure surfaces as a typed envelope, not a throw", async () => {
    getMockProvider().generateOverrides.generate = () => ({ nope: true });
    const toolCtx = makeCtx();
    const result = await authorWorkflowTool.execute(toolCtx, { goal: "impossible" });
    expect(result.ok).toBe(false);
    const data = result.data as { error_code: string };
    expect(data.error_code).toBe("authoring_generation_failed");
  });
});

describe("runAuthoringPipeline — trigger preservation on edit (webhook-binding safety)", () => {
  const WEBHOOK_TRIGGER: WorkflowTrigger = {
    kind: "webhook",
    source: "stripe",
    events: [],
    verify: "stripe-signature",
  };

  function seedWebhookEditDraft(toolCtx: ReturnType<typeof makeCtx>, slug: string) {
    const seeded = createEmptyDraftDocument("workflow_authoring");
    seeded.workflow = {
      name: "Top repos digest",
      slug,
      steps: [],
      trigger: { ...WEBHOOK_TRIGGER },
    };
    return toolCtx.setDraft(seeded);
  }

  tw(
    "preserves an existing webhook trigger when the regenerated draft (same slug) omits it",
    async () => {
      getMockProvider().generateOverrides.generate = () => VALID_DEF;
      const toolCtx = makeCtx();
      await seedWebhookEditDraft(toolCtx, "top-repos-digest");

      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "tweak the digest step" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.definition.trigger).toEqual({ ...WEBHOOK_TRIGGER });
      expect(toolCtx._draft.value?.workflow.trigger).toEqual({ ...WEBHOOK_TRIGGER });
      expect(fetchCalls).toBe(0);
    },
  );

  tw("respects an explicitly regenerated trigger (schedule) over the saved webhook", async () => {
    const SCHEDULED = {
      ...VALID_DEF,
      trigger: { kind: "schedule", cron: "0 9 * * *", tz: "Europe/Berlin" },
    };
    getMockProvider().generateOverrides.generate = () => SCHEDULED;
    const toolCtx = makeCtx();
    await seedWebhookEditDraft(toolCtx, "top-repos-digest");

    const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "make it run daily at 9am" });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.definition.trigger?.kind).toBe("schedule");
    expect(toolCtx._draft.value?.workflow.trigger?.kind).toBe("schedule");
    expect(fetchCalls).toBe(0);
  });

  tw(
    "does NOT preserve on a full replace (regenerated slug differs from the saved workflow)",
    async () => {
      getMockProvider().generateOverrides.generate = () => VALID_DEF;
      const toolCtx = makeCtx();
      await seedWebhookEditDraft(toolCtx, "some-other-workflow");

      const result = await runAuthoringPipeline({
        ctx: toolCtx,
        goal: "a totally different workflow",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.definition.trigger).toBeUndefined();
      expect(toolCtx._draft.value?.workflow.trigger).toBeUndefined();
      expect(fetchCalls).toBe(0);
    },
  );
});

describe("runAuthoringPipeline — semantic critic wire-in", () => {
  const DRIFT_FIXED_DEF = {
    ...VALID_DEF,
    name: "Top repos digest (repaired)",
    slug: "top-repos-digest-repaired",
  };

  tw(
    "default-off: a static-clean draft is returned unchanged and the critic never runs",
    async () => {
      await setConfigKey(["llm", "critic", "enabled"], false);
      getMockProvider().generateOverrides.generate = () => VALID_DEF;
      const toolCtx = makeCtx();
      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "top repos please" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.attempts).toBe(1);
      expect(result.definition.slug).toBe("top-repos-digest");
      expect(result.critic_rejection).toBeUndefined();
      expect(getMockProvider().calls.filter((c) => c.flow === "critic_authoring")).toHaveLength(0);
      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "enabled: a green-static but semantically-drifted draft is caught by the critic and repaired via one more grounded pass",
    async () => {
      try {
        await setConfigKey(["llm", "critic", "enabled"], true);
        await setConfigKey(["llm", "critic", "min_steps"], 2);

        let genCalls = 0;
        getMockProvider().generateOverrides.generate = () => {
          genCalls += 1;
          return genCalls === 1 ? VALID_DEF : DRIFT_FIXED_DEF;
        };
        getMockProvider().generateOverrides.critic_authoring = () => ({
          passed: false,
          repairs: ["Reorder shape_repos before fetch_repos consumes it"],
          rationale: "step order drift",
        });

        const toolCtx = makeCtx();
        const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "top repos with names" });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");

        expect(getMockProvider().calls.filter((c) => c.flow === "critic_authoring")).toHaveLength(
          1,
        );
        expect(genCalls).toBe(2);
        expect(result.attempts).toBe(2);
        expect(result.definition.slug).toBe("top-repos-digest-repaired");
        expect(result.critic_rejection).toBeDefined();
        expect(result.critic_rejection?.repairs[0]).toContain("Reorder shape_repos");
        expect(result.critic_rejection?.gating_reason).toBe("step_count");
        const genPrompts = getMockProvider().calls.filter((c) => c.flow === "generate");
        expect(genPrompts).toHaveLength(2);
        expect(genPrompts[1]?.last_user).toContain("Findings from the previous attempt");
        expect(genPrompts[1]?.last_user).toContain("Reorder shape_repos");
        expect(fetchCalls).toBe(0);
      } finally {
        await setConfigKey(["llm", "critic", "enabled"], false);
        await setConfigKey(["llm", "critic", "min_steps"], 3);
      }
    },
  );

  tw(
    "author_workflow surfaces the critic_rejection advisory on its SUCCESSFUL result (feeds the next-turn signal)",
    async () => {
      try {
        await setConfigKey(["llm", "critic", "enabled"], true);
        await setConfigKey(["llm", "critic", "min_steps"], 2);
        getMockProvider().generateOverrides.generate = () => VALID_DEF;
        getMockProvider().generateOverrides.critic_authoring = () => ({
          passed: false,
          repairs: ["Add an idempotency_key to the POST step"],
          rationale: "missing idempotency",
        });
        const toolCtx = makeCtx();
        const result = await authorWorkflowTool.execute(toolCtx, { goal: "repos digest" });
        expect(result.ok).toBe(true);
        const data = result.data as {
          persistence: string;
          critic_rejection?: { repairs: string[]; rationale: string; gating_reason: string };
        };
        expect(data.persistence).toBe("draft_only");
        expect(data.critic_rejection).toBeDefined();
        expect(data.critic_rejection?.repairs[0]).toContain("idempotency_key");
        expect((data as { error_code?: string }).error_code).toBeUndefined();
        expect(fetchCalls).toBe(0);
      } finally {
        await setConfigKey(["llm", "critic", "enabled"], false);
        await setConfigKey(["llm", "critic", "min_steps"], 3);
      }
    },
  );
});

describe("runAuthoringPipeline — ask-first: placeholder destinations are refused, not regenerated", () => {
  const PLACEHOLDER_BODY_DEF = {
    name: "Droplet report",
    slug: "droplet-report",
    steps: [
      {
        id: "send",
        kind: "request",
        method: "POST",
        url: "https://api.acme.com/send",
        body: { to: "user@example.com", subject: "Droplets" },
      },
    ],
  };
  const PLACEHOLDER_TRANSFORM_DEF = {
    name: "Droplet report",
    slug: "droplet-report",
    steps: [
      {
        id: "compose",
        kind: "transform",
        language: "javascript",
        expression: 'return { to: "recipient@example.com", body: "report" };',
      },
    ],
  };
  const PARAMETERIZED_DEF = {
    name: "Droplet report",
    slug: "droplet-report",
    input_schema: {
      type: "object",
      properties: { recipient: { type: "string" } },
      required: ["recipient"],
    },
    steps: [
      {
        id: "send",
        kind: "request",
        method: "POST",
        url: "https://api.acme.com/send",
        // biome-ignore lint/suspicious/noTemplateCurlyInString: the parameterized recipient is the correct design under test
        body: { to: "${input.recipient}", subject: "Droplets" },
      },
    ],
  };

  for (const [label, def, path] of [
    ["request body.to", PLACEHOLDER_BODY_DEF, "steps.send.body.to"],
    ["JS transform expression", PLACEHOLDER_TRANSFORM_DEF, "steps.compose.expression"],
  ] as const) {
    tw(
      `${label}: ONE pass, authoring_definition_invalid + requires_user_input, field named, nothing stashed, zero egress`,
      async () => {
        let calls = 0;
        getMockProvider().generateOverrides.generate = () => {
          calls += 1;
          return def;
        };
        const toolCtx = makeCtx();
        const result = await runAuthoringPipeline({
          ctx: toolCtx,
          goal: "Send me a daily report of my DigitalOcean droplets by email.",
        });
        expect(result.ok).toBe(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.error_code).toBe("authoring_definition_invalid");
        expect(result.requires_user_input).toBe(true);
        expect(result.attempts).toBe(1);
        expect(calls).toBe(1);
        expect(result.placeholder_destinations?.map((v) => v.path)).toEqual([path]);
        expect(result.errors.map((e) => e.path)).toEqual([path]);
        expect(result.message).toContain(`${path}: placeholder destination`);
        expect(result.message).toContain("with ask_user_text or ask_user_form");
        expect(toolCtx._draft.value).toBeNull();
        expect(fetchCalls).toBe(0);
      },
    );
  }

  tw(
    "a parameterized destination (a runtime input placeholder) is the correct design and passes",
    async () => {
      getMockProvider().generateOverrides.generate = () => PARAMETERIZED_DEF;
      const toolCtx = makeCtx();
      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "email the droplet report" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(result.attempts).toBe(1);
      expect(result.validation.ok).toBe(true);
      expect(toolCtx._draft.value?.workflow.slug).toBe("droplet-report");
      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "author_workflow envelope: requires_user_input, ask-first next_best_actions, placeholder_destinations, previous draft kept",
    async () => {
      getMockProvider().generateOverrides.generate = () => PLACEHOLDER_BODY_DEF;
      const toolCtx = makeCtx();
      const before = createEmptyDraftDocument();
      before.workflow = {
        name: "Kept",
        slug: "kept",
        steps: [{ id: "a", kind: "transform", language: "javascript", expression: "return 1;" }],
      };
      toolCtx._draft.value = before;
      const result = await authorWorkflowTool.execute(toolCtx, {
        goal: "Send me a daily report of my DigitalOcean droplets by email.",
      });
      expect(result.ok).toBe(false);
      const data = result.data as {
        error_code: string;
        requires_user_input: boolean;
        next_best_actions: string[];
        placeholder_destinations: Array<{ path: string; match: string }>;
        attempts: number;
      };
      expect(data.error_code).toBe("authoring_definition_invalid");
      expect(data.requires_user_input).toBe(true);
      expect(data.next_best_actions).toEqual(["ask_user_text", "ask_user_form", "author_workflow"]);
      expect(data.placeholder_destinations).toEqual([
        expect.objectContaining({ path: "steps.send.body.to", match: "user@example.com" }),
      ]);
      expect(data.attempts).toBe(1);
      expect(toolCtx._draft.value?.workflow.slug).toBe("kept");
      expect(fetchCalls).toBe(0);
    },
  );
});
