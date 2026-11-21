import { describe, expect, test } from "bun:test";
import { connectors, skills } from "../../db/schema/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import { LLM_CALL_TIMEOUT_MS } from "../../llm/runtime/ai-sdk-model.ts";
import { recordSuccessShape } from "../../schema-versions/index.ts";
import {
  GeneratedWorkflowSchema,
  MAX_GENERATION_PASSES,
  PIPELINE_DEADLINE_MS,
  runAuthoringPipeline,
} from "../authoring-pipeline.ts";
import {
  _withConnectorPreflightForTests,
  type ConnectorPreflightArgs,
  PREFLIGHT_BUDGET_MS,
} from "../authoring-preflight.ts";
import {
  ctx,
  fetchCalls,
  makeCtx,
  NEVER_VALID_DEF,
  tenant_id,
  tw,
  useAuthoringPipelineSetup,
  VALID_DEF,
} from "./authoring-pipeline-fixtures.ts";

useAuthoringPipelineSetup();

describe("runAuthoringPipeline — grounding", () => {
  tw(
    "two connectors: pre-flight runs once per connector and both connectors' skills and quirks reach the generate context",
    async () => {
      const inserted = await ctx.db
        .insert(connectors)
        .values([
          {
            tenant_id,
            slug: "scope-crm",
            display_name: "Scope CRM",
            driver: "http",
            base_url: "https://crm.scope.test",
            auth_type: "none",
            operator_quirks: { general: "CRM_QUIRK_MARKER: contacts page with cursor tokens." },
          },
          {
            tenant_id,
            slug: "scope-mailer",
            display_name: "Scope Mailer",
            driver: "http",
            base_url: "https://mailer.scope.test",
            auth_type: "none",
            operator_quirks: { general: "MAILER_QUIRK_MARKER: send requires a plain-text body." },
          },
        ])
        .returning();
      const crm = inserted.find((c) => c.slug === "scope-crm");
      const mailer = inserted.find((c) => c.slug === "scope-mailer");
      if (!crm || !mailer) throw new Error("connector fixtures missing");
      const skillRows = await ctx.db
        .insert(skills)
        .values([
          {
            tenant_id,
            slug: "scope-crm-paging",
            title: "Scope CRM paging",
            body: "Follow the cursor until it is null.",
            scope: "connector",
            connector_id: crm.id,
            lifecycle: "active",
            source: "template",
          },
          {
            tenant_id,
            slug: "scope-mailer-sending",
            title: "Scope Mailer sending",
            body: "Send one message per recipient.",
            scope: "connector",
            connector_id: mailer.id,
            lifecycle: "active",
            source: "template",
          },
        ])
        .returning();

      const preflightCalls: string[] = [];
      const stub = async (args: ConnectorPreflightArgs) => {
        preflightCalls.push(args.connector.id);
        expect(args.signal.aborted).toBe(false);
        return null;
      };
      getMockProvider().generateOverrides.generate = () => VALID_DEF;
      const result = await _withConnectorPreflightForTests(stub, () =>
        runAuthoringPipeline({
          ctx: makeCtx(),
          goal: "Mail every new CRM contact a welcome note",
          connector_ids: ["scope-crm", "scope-mailer"],
        }),
      );
      expect(result.ok).toBe(true);
      expect(preflightCalls.sort()).toEqual([crm.id, mailer.id].sort());

      const generateCall = getMockProvider().calls.find((c) => c.flow === "generate");
      if (!generateCall) throw new Error("generate call missing");
      expect(generateCall.system).toContain("CRM_QUIRK_MARKER");
      expect(generateCall.system).toContain("MAILER_QUIRK_MARKER");
      expect(generateCall.system).toContain("Operator quirks — connector `scope-crm`");
      expect(generateCall.system).toContain("Operator quirks — connector `scope-mailer`");
      for (const skill of skillRows) {
        expect(generateCall.included_skill_ids).toContain(skill.id);
      }
      expect(fetchCalls).toBe(0);
    },
  );

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
    expect(PIPELINE_DEADLINE_MS - PREFLIGHT_BUDGET_MS).toBeGreaterThanOrEqual(
      MAX_GENERATION_PASSES * LLM_CALL_TIMEOUT_MS,
    );
  });
});
