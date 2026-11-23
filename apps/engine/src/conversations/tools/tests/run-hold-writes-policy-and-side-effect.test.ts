import { describe, expect, it } from "bun:test";
import { createEmptyDraftDocument, withWorkflowDraft } from "../../authoring-state/index.ts";
import { resolveToolMode } from "../../tool-policies.ts";
import type { DraftDocument } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { inspectWorkflowDraftTool } from "../inspect-workflow-draft.ts";

function runWorkflowMode(input: Record<string, unknown>) {
  return resolveToolMode({
    tool: "run_workflow",
    category: "tenant_write",
    input,
    overrides: {},
  });
}

describe("resolveToolMode for run_workflow (enforcement table)", () => {
  it("execute_writes:true delegates to bounded admission in dev", () => {
    expect(runWorkflowMode({ workflow: "my-wf", execute_writes: true, environment: "dev" })).toBe(
      "no_confirm",
    );
  });

  it("execute_writes:true with no environment delegates to bounded admission", () => {
    expect(runWorkflowMode({ workflow: "my-wf", execute_writes: true })).toBe("no_confirm");
  });

  it("execute_writes omitted in dev → no_confirm (hold-writes is the default)", () => {
    expect(runWorkflowMode({ workflow: "my-wf", environment: "dev" })).toBe("no_confirm");
  });

  it("execute_writes:false in dev → no_confirm (hold-writes default path)", () => {
    expect(runWorkflowMode({ workflow: "my-wf", execute_writes: false, environment: "dev" })).toBe(
      "no_confirm",
    );
  });

  it("execute_writes omitted in prod delegates to local admission (otherwise held)", () => {
    expect(runWorkflowMode({ workflow: "my-wf", environment: "prod" })).toBe("no_confirm");
  });

  it("execute_writes:true in prod delegates to bounded admission", () => {
    expect(runWorkflowMode({ workflow: "my-wf", execute_writes: true, environment: "prod" })).toBe(
      "no_confirm",
    );
  });

  it("omitted environment leaves default resolution and authority checking to admission", () => {
    expect(runWorkflowMode({ workflow: "my-wf" })).toBe("no_confirm");
  });
});

function makeDraftCtx(draft: DraftDocument): ToolContext {
  return {
    db: {} as ToolContext["db"],
    tenant_id: "t-unit-test",
    conversation_id: "conv-unit-test",
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: {} as ToolContext["engineClient"],
    getDraft: () => draft,
    setDraft: async () => {},
  } as ToolContext;
}

function draftWithSteps(steps: Array<Record<string, unknown>>): DraftDocument {
  const empty = createEmptyDraftDocument();
  return withWorkflowDraft(
    empty,
    {
      ...empty.workflow,
      name: "side-effect test workflow",
      slug: "side-effect-test",
      steps,
    } as never,
    "t15_seed",
  );
}

describe("inspect_workflow_draft side_effect labels", () => {
  it("GET request step → side_effect: 'read'", async () => {
    const draft = draftWithSteps([
      { id: "fetch", kind: "request", method: "GET", url: "https://api.example.com/data" },
    ]);
    const result = await inspectWorkflowDraftTool.execute(makeDraftCtx(draft), {});
    expect(result.ok).toBe(true);
    const data = result.data as {
      workflow?: { steps?: Array<{ id: string; side_effect: string }> };
    };
    const step = data.workflow?.steps?.find((s) => s.id === "fetch");
    expect(step).toBeDefined();
    expect(step?.side_effect).toBe("read");
  });

  it("POST request step → side_effect: 'write'", async () => {
    const draft = draftWithSteps([
      { id: "send", kind: "request", method: "POST", url: "https://api.example.com/send" },
    ]);
    const result = await inspectWorkflowDraftTool.execute(makeDraftCtx(draft), {});
    expect(result.ok).toBe(true);
    const data = result.data as {
      workflow?: { steps?: Array<{ id: string; side_effect: string }> };
    };
    const step = data.workflow?.steps?.find((s) => s.id === "send");
    expect(step).toBeDefined();
    expect(step?.side_effect).toBe("write");
  });

  it("PUT request step → side_effect: 'write'", async () => {
    const draft = draftWithSteps([
      { id: "update", kind: "request", method: "PUT", url: "https://api.example.com/items/1" },
    ]);
    const result = await inspectWorkflowDraftTool.execute(makeDraftCtx(draft), {});
    expect(result.ok).toBe(true);
    const data = result.data as {
      workflow?: { steps?: Array<{ id: string; side_effect: string }> };
    };
    const step = data.workflow?.steps?.find((s) => s.id === "update");
    expect(step?.side_effect).toBe("write");
  });

  it("transform step → side_effect: 'read' (non-request steps have no external side effect)", async () => {
    const draft = draftWithSteps([
      {
        id: "extract",
        kind: "transform",
        language: "javascript",
        expression: "return input.data;",
      },
    ]);
    const result = await inspectWorkflowDraftTool.execute(makeDraftCtx(draft), {});
    expect(result.ok).toBe(true);
    const data = result.data as {
      workflow?: { steps?: Array<{ id: string; side_effect: string }> };
    };
    const step = data.workflow?.steps?.find((s) => s.id === "extract");
    expect(step?.side_effect).toBe("read");
  });

  it("mixed workflow — GET is read, POST is write in same result", async () => {
    const draft = draftWithSteps([
      { id: "fetch", kind: "request", method: "GET", url: "https://api.example.com/data" },
      { id: "send", kind: "request", method: "POST", url: "https://api.example.com/send" },
    ]);
    const result = await inspectWorkflowDraftTool.execute(makeDraftCtx(draft), {});
    expect(result.ok).toBe(true);
    const data = result.data as {
      workflow?: { steps?: Array<{ id: string; side_effect: string }> };
    };
    const steps = data.workflow?.steps ?? [];
    const fetchStep = steps.find((s) => s.id === "fetch");
    const sendStep = steps.find((s) => s.id === "send");
    expect(fetchStep?.side_effect).toBe("read");
    expect(sendStep?.side_effect).toBe("write");
  });

  it("explicit side_effects override wins: POST forced to read", async () => {
    const draft = draftWithSteps([
      {
        id: "search",
        kind: "request",
        method: "POST",
        url: "https://api.example.com/search",
        side_effects: "read",
      },
    ]);
    const result = await inspectWorkflowDraftTool.execute(makeDraftCtx(draft), {});
    expect(result.ok).toBe(true);
    const data = result.data as {
      workflow?: { steps?: Array<{ id: string; side_effect: string }> };
    };
    const step = data.workflow?.steps?.find((s) => s.id === "search");
    expect(step?.side_effect).toBe("read");
  });

  it("DELETE request step → side_effect: 'write'", async () => {
    const draft = draftWithSteps([
      {
        id: "remove",
        kind: "request",
        method: "DELETE",
        url: "https://api.example.com/items/1",
      },
    ]);
    const result = await inspectWorkflowDraftTool.execute(makeDraftCtx(draft), {});
    expect(result.ok).toBe(true);
    const data = result.data as {
      workflow?: { steps?: Array<{ id: string; side_effect: string }> };
    };
    const step = data.workflow?.steps?.find((s) => s.id === "remove");
    expect(step?.side_effect).toBe("write");
  });
});

it("configuration inspection stays small after a large preview and targets steps by ID", async () => {
  const draft = draftWithSteps([
    {
      id: "store",
      kind: "request",
      protocol: "s3",
      method: "PUT",
      s3: { key: "reports/${input.day}" },
      body: "${input.report}",
    },
    { id: "unrelated", kind: "transform", expression: "return input;" },
  ]);
  const large = "PRIVATE_EXECUTION_PAYLOAD".repeat(25000);
  draft.latest_preview = {
    ok: true,
    summary: "Preview succeeded",
    preview: large,
    step_traces: [{ step_id: "store", status: "succeeded", output_preview: large }],
  } as NonNullable<DraftDocument["latest_preview"]>;
  const result = await inspectWorkflowDraftTool.execute(makeDraftCtx(draft), {});
  const text = JSON.stringify(result.data);
  expect(text.length).toBeLessThan(12000);
  expect(text).not.toContain("PRIVATE_EXECUTION_PAYLOAD");
  expect(text).toContain("reports/");
  const selected = await inspectWorkflowDraftTool.execute(makeDraftCtx(draft), {
    step_ids: ["store"],
  });
  const data = selected.data as {
    workflow: { steps: Array<{ id: string; configuration: unknown }> };
  };
  expect(data.workflow.steps).toHaveLength(1);
  expect(data.workflow.steps[0]?.configuration).toEqual(draft.workflow.steps[0]);
  const preview = await inspectWorkflowDraftTool.execute(makeDraftCtx(draft), {
    step_ids: ["store"],
    include_preview: true,
  });
  expect(JSON.stringify(preview.data)).toContain("PRIVATE_EXECUTION_PAYLOAD");
});
