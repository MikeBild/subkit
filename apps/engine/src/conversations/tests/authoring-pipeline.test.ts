import { describe, expect } from "bun:test";
import { setConfigKey } from "../../config/loader.ts";
import { callerFromPrincipal } from "../../execution/caller-context.ts";
import { runExecution } from "../../execution/engine.ts";
import { LlmProviderError, LlmSpendLimitReached } from "../../llm/errors.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { MAX_GENERATION_PASSES, runAuthoringPipeline } from "../authoring-pipeline.ts";
import { createEmptyDraftDocument } from "../authoring-state/index.ts";
import { authorWorkflowTool } from "../tools/author-workflow.ts";
import { dryRunWorkflowTool } from "../tools/dry-run-workflow.ts";
import {
  ctx,
  fetchCalls,
  makeCtx,
  NEVER_VALID_DEF,
  nextUuid,
  tenant_id,
  tw,
  useAuthoringPipelineSetup,
  VALID_DEF,
} from "./authoring-pipeline-fixtures.ts";

useAuthoringPipelineSetup();

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
    "generated product and sensitive headers survive authoring and a mismatched caller cannot preview them",
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
      expect(authored.next).toBe("dry_run_workflow");
      expect(toolCtx.getDraft().workflow).toMatchObject(headers);
      const initial = JSON.stringify(toolCtx.getDraft());
      let writes = 0;
      toolCtx.setDraft = async () => {
        writes++;
      };
      const preview = await dryRunWorkflowTool.execute(toolCtx, {
        input: { secret: "private-input-canary" },
      });
      expect(preview).toMatchObject({ ok: false, error_code: "caller_product_mismatch" });
      expect(JSON.stringify(preview)).not.toContain("private-input-canary");
      expect(writes).toBe(0);
      expect(JSON.stringify(toolCtx.getDraft())).toBe(initial);
      expect(fetchCalls).toBe(0);
    },
  );

  tw("sensitive authoring directs the client to the metadata-only test run", async () => {
    getMockProvider().generateOverrides.generate = () => ({
      name: "Private report",
      slug: "private-report",
      execution_privacy: "sensitive",
      steps: [
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression: "return input.input;",
        },
      ],
    });
    const toolCtx = makeCtx();
    const result = await authorWorkflowTool.execute(toolCtx, {
      goal: "Prepare a private report",
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ next_step: "dry_run_workflow" });
    expect(JSON.stringify(result.data)).toContain("returns metadata only");
    expect(JSON.stringify(result.data)).not.toContain("auto-commits");
    expect(toolCtx.getDraft().workflow?.execution_privacy).toBe("sensitive");
    expect(fetchCalls).toBe(0);
  });

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
    "a generation model that declines names its reason in the author_workflow failure instead of a generic parse error",
    async () => {
      getMockProvider().generateOverrides.generate = () => {
        throw new Error(
          "the webhook destination is missing; supplying it would require inventing one",
        );
      };
      const toolCtx = makeCtx();
      const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "email the report" });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error_code).toBe("authoring_generation_failed");
      expect(result.message).toContain("the webhook destination is missing");
      expect(result.message).not.toContain("schema-parseable");
      expect(toolCtx._draft.value).toBeNull();
      expect(fetchCalls).toBe(0);
    },
  );

  tw("provider quota ends authoring after one pass with a repair hint", async () => {
    let calls = 0;
    const retryAt = new Date(0).toISOString();
    getMockProvider().generateOverrides.generate = () => {
      calls += 1;
      throw new LlmProviderError("quota_exhausted", "API usage limit", {
        retry_at: retryAt,
      });
    };
    const toolCtx = makeCtx();
    const result = await authorWorkflowTool.execute(toolCtx, { goal: "digest the repos" });
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      error_code: "llm_provider_quota_exhausted",
      attempts: 1,
      next_best_actions: [],
    });
    expect(JSON.stringify(result.data)).toContain(retryAt);
    expect(calls).toBe(1);
    expect(toolCtx._draft.value).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  tw("tenant token budget ends authoring without a second generation pass", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.generate = () => {
      calls += 1;
      throw new LlmSpendLimitReached();
    };
    const toolCtx = makeCtx();
    const result = await authorWorkflowTool.execute(toolCtx, { goal: "digest the repos" });
    expect(result.ok).toBe(false);
    expect(result.data).toMatchObject({
      error_code: "llm_spend_limit_reached",
      attempts: 1,
      next_best_actions: [],
    });
    expect(calls).toBe(1);
    expect(toolCtx._draft.value).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  tw("provider usage-limit text from the live error path is terminal", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.generate = () => {
      calls += 1;
      throw new Error("You have reached your specified API usage limits.");
    };
    const toolCtx = makeCtx();
    const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "digest the repos" });
    expect(result).toMatchObject({
      ok: false,
      error_code: "llm_provider_quota_exhausted",
      attempts: 1,
    });
    expect(calls).toBe(1);
    expect(toolCtx._draft.value).toBeNull();
    expect(fetchCalls).toBe(0);
  });

  tw("a generated workflow with no executable steps never becomes a draft", async () => {
    let calls = 0;
    getMockProvider().generateOverrides.generate = () => {
      calls += 1;
      return { ...VALID_DEF, steps: [] };
    };
    const toolCtx = makeCtx();
    const result = await runAuthoringPipeline({ ctx: toolCtx, goal: "digest the repos" });
    expect(result).toMatchObject({
      ok: false,
      error_code: "authoring_generation_failed",
      attempts: MAX_GENERATION_PASSES,
    });
    expect(calls).toBe(MAX_GENERATION_PASSES);
    expect(toolCtx._draft.value).toBeNull();
    expect(fetchCalls).toBe(0);
  });

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
