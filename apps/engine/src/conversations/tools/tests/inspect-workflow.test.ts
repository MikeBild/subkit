// inspect_workflow returns config + captured run
// result for every requested step in one call. This is the schema-first
// preflight that lets the
// LLM author the next patch against the actual scope shape instead of
// guessing — closes the gap that drove the 30-iteration update_param
// loops.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createEmptyDraftDocument, withWorkflowDraft } from "../../authoring-state.ts";
import type { DraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { inspectWorkflowTool } from "../inspect-workflow.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("inspect_workflow");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-inspect", display_name: "T" })
    .returning();
  tenant_id = t!.id;
});
afterAll(async () => {
  await ctx.cleanup();
});

function makeCtx(initialDraft: DraftDocument): ToolContext & { draft: DraftDocument } {
  const state: { draft: DraftDocument } = { draft: initialDraft };
  return {
    db: ctx.db,
    tenant_id,
    conversation_id: crypto.randomUUID(), // allow-random: deterministic id not required for shape tests
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({ tenant_id, actor_id: null, db: ctx.db }),
    getDraft: () => state.draft,
    setDraft: async (next) => {
      state.draft = next;
    },
    get draft() {
      return state.draft;
    },
  } as ToolContext & { draft: DraftDocument };
}

function draftWithSteps(steps: Array<Record<string, unknown>>): DraftDocument {
  const empty = createEmptyDraftDocument();
  return withWorkflowDraft(
    empty,
    {
      ...empty.workflow,
      name: "Test workflow",
      slug: "test-wf",
      description: "test",
      steps,
    } as never,
    "test_seed",
  );
}

describe("inspect_workflow · multi-section + multi-step in one call", () => {
  test("returns instruction + payload sections together", async () => {
    const draft = draftWithSteps([
      { id: "fetch_projects", kind: "request", method: "GET", path: "/v2/projects" },
    ]);
    const toolCtx = makeCtx(draft);
    const result = await inspectWorkflowTool.execute(toolCtx, {
      sections: ["instruction", "payload"],
    });
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data).toHaveProperty("instruction");
    expect(data).toHaveProperty("payload");
    expect(data.workflow_slug).toBe("test-wf");
    expect(data.step_count).toBe(1);
  });

  test("returns config + result for multiple steps in a single call", async () => {
    const draft = draftWithSteps([
      { id: "fetch", kind: "request", method: "GET", path: "/v2/projects" },
      { id: "extract", kind: "transform", language: "javascript", expression: "return input;" },
      {
        id: "fetch_resources",
        kind: "loop",
        over: "$scope.extract.data",
        item_var: "project",
        body: ["fetch_one"],
      },
    ]);
    const toolCtx = makeCtx(draft);
    const result = await inspectWorkflowTool.execute(toolCtx, {
      steps: [
        { stepId: "fetch", include: ["config"] },
        { stepId: "extract", include: ["config", "result"] },
        { stepId: "fetch_resources", include: ["config"] },
      ],
    });
    expect(result.ok).toBe(true);
    const data = result.data as { steps: Array<Record<string, unknown>> };
    expect(data.steps).toHaveLength(3);
    expect(data.steps[0]?.step_id).toBe("fetch");
    expect(data.steps[1]?.step_id).toBe("extract");
    expect(data.steps[1]?.result).toEqual({ status: "no_result" });
    expect(data.steps[2]?.step_id).toBe("fetch_resources");
    const fetchConfig = data.steps[0]?.config as Record<string, unknown>;
    expect(fetchConfig.method).toBe("GET");
    expect(fetchConfig.path).toBe("/v2/projects");
    expect(data.steps[0]?.kind).toBe("request");
  });

  test("step_not_found includes available_step_ids so the model can retry", async () => {
    const draft = draftWithSteps([
      { id: "fetch_projects", kind: "request", method: "GET", path: "/v2/projects" },
    ]);
    const toolCtx = makeCtx(draft);
    const result = await inspectWorkflowTool.execute(toolCtx, {
      steps: [{ stepId: "does_not_exist", include: ["config"] }],
    });
    expect(result.ok).toBe(true);
    const data = result.data as { steps: Array<Record<string, unknown>> };
    expect(data.steps[0]?.error).toBe("step_not_found");
    expect(data.steps[0]?.available_step_ids).toEqual(["fetch_projects"]);
  });

  test("returns captured output_preview from latest_preview when present", async () => {
    const draft = draftWithSteps([
      { id: "fetch", kind: "request", method: "GET", path: "/v2/projects" },
    ]);
    // Canonical surface: latest_preview.step_traces. The legacy
    // step_outputs fallback was removed when step_traces became the
    // source of truth.
    const draftWithPreview: DraftDocument = {
      ...draft,
      latest_preview: {
        ok: true,
        step_id: "fetch",
        summary: "Ran 1 step",
        preview: { projects: [{ id: "p1", name: "Acme" }] },
        step_traces: [
          {
            step_id: "fetch",
            kind: "request",
            status: "succeeded",
            output_preview: { data: { projects: [{ id: "p1" }] } },
          },
        ],
      },
    };
    const toolCtx = makeCtx(draftWithPreview);
    const result = await inspectWorkflowTool.execute(toolCtx, {
      steps: [{ stepId: "fetch", include: ["result"] }],
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      steps: Array<Record<string, unknown>>;
      has_latest_preview: boolean;
    };
    expect(data.has_latest_preview).toBe(true);
    expect(data.steps[0]?.result).toMatchObject({
      step_id: "fetch",
      kind: "request",
      status: "succeeded",
    });
  });

  test("requires_skill is set so the model must load workflow-authoring first", () => {
    expect(inspectWorkflowTool.requires_skill).toBe("workflow-authoring");
    expect(inspectWorkflowTool.category).toBe("tenant_read");
  });

  test("output_transform section reports last_step_passthrough when no transform set (Polish A)", async () => {
    const draft = draftWithSteps([
      { id: "fetch_page", kind: "request", method: "GET", path: "/wiki/api/v2/pages/87263947" },
    ]);
    const toolCtx = makeCtx(draft);
    const result = await inspectWorkflowTool.execute(toolCtx, {
      sections: ["output_transform"],
    });
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.output_transform).toBeNull();
    expect(data.output_behavior).toBe("last_step_passthrough");
  });

  // The output_transform section's `output_behavior` field lives in
  // `important_notes` documentation, not a Zod schema.
  // Assert the literal field name + literal enum members so a silent
  // rename trips a test before shipping.
  test("output_transform section keeps the literal field name 'output_behavior'", async () => {
    const draft = draftWithSteps([{ id: "fetch_page", kind: "request", method: "GET", path: "/" }]);
    const toolCtx = makeCtx(draft);
    const result = await inspectWorkflowTool.execute(toolCtx, {
      sections: ["output_transform"],
    });
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(Object.keys(data)).toContain("output_behavior");
    // Literal enum members must remain stable.
    expect(["explicit_transform", "transform_function", "last_step_passthrough"]).toContain(
      data.output_behavior as string,
    );
  });

  test("input_schema section surfaces the resolved contract + sample (D4)", async () => {
    // Payload-first: a workflow authored WITH a sample (and no declared
    // input_schema) must expose a real required-list derived from that
    // sample, plus the literal sample, so the model can author against it.
    const empty = createEmptyDraftDocument();
    const draft = withWorkflowDraft(
      empty,
      {
        ...empty.workflow,
        name: "Render deck",
        slug: "render-deck",
        steps: [{ id: "upload", kind: "request", method: "POST", url: "/u/${input.markdown}" }],
        input_schema_sample: { markdown: "# hi", filename: "deck.md" },
      } as never,
      "test_seed",
    );
    const toolCtx = makeCtx(draft);
    const result = await inspectWorkflowTool.execute(toolCtx, { sections: ["input_schema"] });
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    // No declared schema — that's the point of the sample idiom.
    expect(data.input_schema).toBeNull();
    // The resolved contract carries the sample-derived required-list.
    const contract = data.input_contract as {
      source: string;
      required: string[];
      properties: string[];
    };
    expect(contract.source).toBe("sample");
    expect(contract.required.sort()).toEqual(["filename", "markdown"]);
    expect(contract.properties.sort()).toEqual(["filename", "markdown"]);
    // And the literal sample rides alongside.
    expect(data.input_schema_sample).toEqual({ markdown: "# hi", filename: "deck.md" });
  });

  test("output_transform section reports explicit_transform when one is declared", async () => {
    const empty = createEmptyDraftDocument();
    const draft = withWorkflowDraft(
      empty,
      {
        ...empty.workflow,
        name: "Test workflow",
        slug: "test-wf",
        description: "test",
        steps: [{ id: "fetch_page", kind: "request", method: "GET", path: "/x" }],
        output_transform: "data.body.storage.value",
      } as never,
      "test_seed",
    );
    const toolCtx = makeCtx(draft);
    const result = await inspectWorkflowTool.execute(toolCtx, {
      sections: ["output_transform"],
    });
    expect(result.ok).toBe(true);
    const data = result.data as Record<string, unknown>;
    expect(data.output_transform).toBe("data.body.storage.value");
    expect(data.output_behavior).toBe("explicit_transform");
  });
});
