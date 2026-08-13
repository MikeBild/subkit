// One-shot authoring pipeline (Fix A).
//
//   - `author_workflow` emits a schema-valid COMPLETE definition with
//     the recorded-eval report attached, the goal stashed on the draft
//     (draft-only metadata for the judge), and `next: dry_run_workflow`,
//   - JS transforms ride through as authored (JS-first contract),
//   - grounding: the ONE generation prompt carries the goal verbatim,
//     the resolved connectors, the recorded endpoint samples
//     (`schema_versions` shapes), and the verbatim JS function-body
//     contract,
//   - bounded passes: a never-converging mock gives up after
//     MAX_GENERATION_PASSES with the findings attached and the draft
//     STILL stashed; a schema-unparseable mock yields a typed failure
//     with nothing stashed,
//   - zero live HTTP anywhere in the pipeline (egress tripwire).
//
// LLM provider is the in-process mock (LLM_PROVIDER=mock bootstrap +
// `generateOverrides.generate`) — no network, deterministic.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfig, loadConfig, setConfigKey } from "../../config/loader.ts";
import { connectors, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { EngineClient } from "../../engine-client/index.ts";
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
import type { ToolContext } from "../tools/index.ts";
import type { DraftDocument } from "../types.ts";

const nextUuid = createDeterministicUuidFactory(0xa07_40);

let ctx: TestDb;
let tenant_id: string;

async function ensureConfigLoaded(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    /* fall through */
  }
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

// Egress tripwire: NO live HTTP may fire anywhere in the pipeline.
// Installed through the driver-fetch seam — drivers no longer read
// globalThis.fetch, so a global stub would miss real egress AND leak
// into concurrently-running sibling test files.
// Each test body runs under the seam's explicit wrapper — an
// enterWith-from-beforeEach binding did not propagate into test bodies
// under bun.
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

/** A complete, valid fixture definition with a JS-first transform. */
const VALID_DEF = {
  name: "Top repos digest",
  slug: "top-repos-digest",
  description: "Fetch repos and shape the top entries.",
  steps: [
    {
      id: "fetch_repos",
      kind: "request",
      method: "GET",
      url: "https://api.example.com/repos",
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

/** Never converges: schema-parseable but ALWAYS fails validateWorkflowDef
 *  (the loop's body references a step id that does not exist — a strict
 *  structural error in the complete-artifact validation). */
const NEVER_VALID_DEF = {
  name: "Broken loop",
  slug: "broken-loop",
  steps: [
    { id: "fetch", kind: "request", method: "GET", url: "https://api.example.com/items" },
    { id: "iter", kind: "loop", over: "$scope.fetch.data", body: ["missing_step"] },
  ],
};

describe("runAuthoringPipeline — one-shot contract", () => {
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
      // JS-first: the authored transform stays `language: "javascript"`.
      const transform = result.definition.steps.find((s) => s.kind === "transform");
      expect(transform?.language).toBe("javascript");
      // Recorded-eval report attached (compile checks ran — the JS body
      // parses, so no compile_error findings).
      expect(
        result.recorded_eval.expressions.filter((f) => f.status === "compile_error"),
      ).toHaveLength(0);

      // Goal + connector ids stashed on the draft as draft-only metadata.
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
      // The regenerate prompt carried the previous pass's findings.
      const generateCalls = getMockProvider().calls.filter((c) => c.flow === "generate");
      expect(generateCalls).toHaveLength(2);
      expect(generateCalls[1]?.last_user).toContain("Findings from the previous attempt");
      expect(generateCalls[1]?.last_user).toContain("missing_step");
      expect(fetchCalls).toBe(0);
    },
  );

  tw(
    "never-converging mock gives up after MAX_GENERATION_PASSES with findings attached and the draft STILL stashed",
    async () => {
      let calls = 0;
      getMockProvider().generateOverrides.generate = () => {
        calls += 1;
        return NEVER_VALID_DEF;
      };
      const toolCtx = makeCtx();
      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "loop the things" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      expect(calls).toBe(MAX_GENERATION_PASSES);
      expect(result.attempts).toBe(MAX_GENERATION_PASSES);
      expect(result.validation.ok).toBe(false);
      expect(result.validation.errors.length).toBeGreaterThan(0);
      // Even the findings-laden definition is stashed — the model repairs
      // from the findings instead of starting over.
      expect(toolCtx._draft.value?.workflow.slug).toBe("broken-loop");
      expect((toolCtx._draft.value!.workflow as { goal?: string }).goal).toBe("loop the things");
      expect(fetchCalls).toBe(0);
    },
  );

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
      // A genuine generation failure must NOT borrow the deadline excuse —
      // the honest-message fix has to stay honest in both directions.
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
      // Seed a recorded response shape — exactly what probe_connector /
      // call_connector record on success.
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
      // Goal verbatim.
      expect(prompt).toContain(goal);
      // Connector grounding: slug + id + auth posture.
      expect(prompt).toContain("examplehub");
      expect(prompt).toContain(connector!.id);
      expect(prompt).toContain("auth bearer");
      // Recorded endpoint samples reach the model BEFORE it writes paths.
      expect(prompt).toContain("Recorded endpoint samples");
      expect(prompt).toContain("GET /v1/widgets");
      // The verbatim JS function-body contract.
      expect(prompt).toContain("FUNCTION BODY");
      expect(prompt).toContain("input.scope.<step_id>.data");
      expect(prompt).toContain("input.input");
      expect(prompt).toContain('language: "javascript"');
      // The bulk-endpoint design rule.
      expect(prompt).toContain("ONE bulk list endpoint over a nested per-item loop");
      // $item-only loop contract.
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
      // `examplehub` was seeded by the grounding test above.
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
    "a deadline/turn abort mid-generation returns the best draft so far with a findings note, no hang",
    async () => {
      // Drive the abort through ctx.abortSignal (merged into the shared
      // pipeline deadline). Pass 1 produces a definition that FAILS
      // validation (so a second pass is wanted), and aborts the signal
      // as a side effect — so the loop-top deadline check fires before
      // pass 2. The pipeline must return the best (pass-1) draft with a
      // note instead of throwing or hanging.
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

      // Degrades gracefully: ok envelope, best draft stashed, note set.
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      // Only ONE generate pass spent — the second was short-circuited by
      // the deadline check, not re-attempted against a blown budget.
      expect(calls).toBe(1);
      expect(result.attempts).toBe(1);
      expect(result.note).toBeDefined();
      expect(result.note).toContain("time budget exceeded");
      // The best draft so far (the pass-1 definition) is stashed for the
      // model to refine from the findings.
      expect(toolCtx._draft.value?.workflow.slug).toBe("broken-loop");
      expect(result.recorded_eval).toBeDefined();
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

    // No generate call fires (the loop-top check breaks immediately) and
    // the pipeline returns a typed failure with nothing stashed.
    expect(calls).toBe(0);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error_code).toBe("authoring_generation_failed");
    // Say WHY. This envelope used to read "the generation model produced no
    // schema-parseable workflow definition" even here, where no model ever
    // ran — and a production caller believed it: it invented tool names,
    // started an unrelated connector draft, and finally abstained claiming
    // `author_workflow` was unavailable, minutes after calling it. The
    // machine-readable flag is what lets a caller branch on "retry / split"
    // rather than "the tool is broken".
    expect(result.deadline_exceeded).toBe(true);
    expect(result.message).toContain("ran out of time");
    expect(result.message).not.toContain("schema-parseable");
    expect(toolCtx._draft.value).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  test("the pipeline budget can fund every pass it promises", () => {
    // The budget is derived from what the pipeline advertises, not chosen.
    // At 120s it promised MAX_GENERATION_PASSES but funded roughly one and a
    // third: a first pass running near its own ceiling left the second unable
    // to finish, and production killed one 33s in — tokens spent, nothing
    // returned. A retry budget that cannot pay for the retry is theatre.
    expect(PIPELINE_DEADLINE_MS).toBeGreaterThanOrEqual(
      MAX_GENERATION_PASSES * LLM_CALL_TIMEOUT_MS,
    );
    // Plus headroom for the bounded repair fan-out that shares this budget.
    expect(
      PIPELINE_DEADLINE_MS - MAX_GENERATION_PASSES * LLM_CALL_TIMEOUT_MS,
    ).toBeGreaterThanOrEqual(LLM_CALL_TIMEOUT_MS);
    // And it must still fit inside the turn that hosts it (10 min).
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

  /** Seed an EDIT: a draft hydrated from a saved workflow that carries a live
   *  webhook trigger. `slug` decides whether the regenerated draft is treated
   *  as an edit of THIS workflow (same slug) or a fresh artifact. */
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
      // VALID_DEF has slug top-repos-digest and NO trigger — the exact
      // regression: a goal that doesn't restate the webhook.
      getMockProvider().generateOverrides.generate = () => VALID_DEF;
      const toolCtx = makeCtx();
      await seedWebhookEditDraft(toolCtx, "top-repos-digest");

      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "tweak the digest step" });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("unreachable");
      // The regenerated definition carries the preserved webhook trigger.
      expect(result.definition.trigger).toEqual({ ...WEBHOOK_TRIGGER });
      // ...and the STASHED draft does too, so a later commit keeps the binding
      // instead of unbinding the public ingress hook.
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
    // The model authored a NEW trigger — preservation must not override it.
    expect(result.definition.trigger?.kind).toBe("schedule");
    expect(toolCtx._draft.value?.workflow.trigger?.kind).toBe("schedule");
    expect(fetchCalls).toBe(0);
  });

  tw(
    "does NOT preserve on a full replace (regenerated slug differs from the saved workflow)",
    async () => {
      // VALID_DEF regenerates slug top-repos-digest; the seeded draft is a
      // DIFFERENT workflow — a genuine new/replaced artifact, not an edit.
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
  // A repaired variant, distinct from VALID_DEF by slug so a
  // critic-triggered regenerate is observable in the final definition.
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
          // Pass 1: the drifted-but-static-valid draft. Pass 2 (triggered
          // by the critic): the repaired draft.
          return genCalls === 1 ? VALID_DEF : DRIFT_FIXED_DEF;
        };
        // The critic rejects the first draft with a concrete repair.
        getMockProvider().generateOverrides.critic_authoring = () => ({
          passed: false,
          repairs: ["Reorder shape_repos before fetch_repos consumes it"],
          rationale: "step order drift",
        });

        const toolCtx = makeCtx();
        const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "top repos with names" });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error("unreachable");

        // Critic ran EXACTLY once and drove exactly one regenerate pass.
        expect(getMockProvider().calls.filter((c) => c.flow === "critic_authoring")).toHaveLength(
          1,
        );
        expect(genCalls).toBe(2);
        expect(result.attempts).toBe(2);
        // The regenerated (repaired) draft replaced the drifted one.
        expect(result.definition.slug).toBe("top-repos-digest-repaired");
        // The rejection advisory rides the SUCCESSFUL result for the next turn.
        expect(result.critic_rejection).toBeDefined();
        expect(result.critic_rejection?.repairs[0]).toContain("Reorder shape_repos");
        expect(result.critic_rejection?.gating_reason).toBe("step_count");
        // Repairs reached the regenerate prompt through the findings channel.
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
        // The tool still SUCCEEDS — the draft was stashed + repaired.
        expect(result.ok).toBe(true);
        const data = result.data as {
          persistence: string;
          critic_rejection?: { repairs: string[]; rationale: string; gating_reason: string };
        };
        expect(data.persistence).toBe("draft_only");
        // Advisory present so the next turn's expandPriorFailuresFromToolCalls
        // escalates via prior_failures — and it is NOT an error_code (the
        // humanizer must not read the successful call as a failure).
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
