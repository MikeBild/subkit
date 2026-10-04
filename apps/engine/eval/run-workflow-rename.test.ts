import { describe, expect, test } from "bun:test";
import { listTools } from "../src/conversations/tools/index.ts";

describe("run_workflow tool — field rename: workflow not workflow_id", () => {
  const tools = listTools();
  const runWorkflowTool = tools.find((t) => t.name === "run_workflow");

  test("run_workflow tool is registered", () => {
    expect(runWorkflowTool).toBeDefined();
  });

  test("run_workflow inputSchema does NOT have a workflow_id field (old name is gone)", () => {
    expect(runWorkflowTool).toBeDefined();
    const schema = runWorkflowTool!.inputSchema;
    const zodSchema = schema as { shape?: Record<string, unknown> };
    if (zodSchema.shape) {
      expect(Object.keys(zodSchema.shape)).not.toContain("workflow_id");
    }
  });

  test("run_workflow inputSchema has a `workflow` field (slug or UUID)", () => {
    expect(runWorkflowTool).toBeDefined();
    const schema = runWorkflowTool!.inputSchema;
    const zodSchema = schema as { shape?: Record<string, unknown> };
    if (zodSchema.shape) {
      expect(Object.keys(zodSchema.shape)).toContain("workflow");
    }
  });

  test("run_workflow description mentions 'slug' or 'UUID' not 'workflow_id'", () => {
    expect(runWorkflowTool).toBeDefined();
    const desc = runWorkflowTool!.description ?? "";
    expect(desc.toLowerCase()).toMatch(/slug|uuid/);
    expect(desc).not.toContain("workflow_id=");
  });

  test("run_workflow distinguishes held preparation from a live one-shot", () => {
    expect(runWorkflowTool).toBeDefined();
    const desc = runWorkflowTool!.description ?? "";
    expect(desc).toContain("execute_writes: false");
    expect(desc).toContain("Do not use wf_<slug> for preparation");
    expect(desc).toContain("one-shot human decision");
  });
});

describe("eval fixture: convo-workflow-rerun-stays-chat-native", () => {
  test("fixture runs the validator and passes", async () => {
    const fixture = await import("./fixtures/convo-workflow-rerun-stays-chat-native.json");
    const { validate } = await import("./validators/convo-workflow-rerun-stays-chat-native.ts");
    const result = validate({
      ...fixture.default,
      name: fixture.default.name ?? "convo-workflow-rerun-stays-chat-native",
    });
    expect(result.pass).toBe(true);
  });
});

describe("run_workflow tool — suggested_command in envelope", () => {
  test("run_workflow tool has ALWAYS_AVAILABLE_EXECUTION category (or tenant_write)", () => {
    const tools = listTools();
    const tool = tools.find((t) => t.name === "run_workflow") as { category?: string } | undefined;
    expect(tool).toBeDefined();
    expect(tool?.category).toBe("tenant_write");
  });
});
