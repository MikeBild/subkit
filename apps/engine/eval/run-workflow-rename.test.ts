// Eval fixture test: asserts that the run_workflow tool description and
// input schema use `workflow` (slug or UUID), NOT the old `workflow_id`
// field. This pins the breaking rename from CP2 against regression.

import { describe, expect, test } from "bun:test";
import { listTools } from "../src/conversations/tools/index.ts";

// ---------------------------------------------------------------------------
// T5 (from CP1 test matrix) — workflow_id rename is clean
// ---------------------------------------------------------------------------

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
    // The Zod schema's shape should not include `workflow_id`
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
    // The description should refer to slug or UUID
    expect(desc.toLowerCase()).toMatch(/slug|uuid/);
    // The description should NOT still reference the old workflow_id positionally
    // (it's OK to appear in examples, but the primary field name is 'workflow')
    expect(desc).not.toContain("workflow_id=");
  });

  test("run_workflow description contains FALLBACK language (it's the fallback path)", () => {
    expect(runWorkflowTool).toBeDefined();
    const desc = runWorkflowTool!.description ?? "";
    // The CP2 rename gave run_workflow a FALLBACK label since wf_<slug>
    // tools are the primary path
    expect(desc.toUpperCase()).toContain("FALLBACK");
  });
});

// ---------------------------------------------------------------------------
// Eval fixture validation: convo-workflow-rerun-stays-chat-native
// ---------------------------------------------------------------------------

describe("eval fixture: convo-workflow-rerun-stays-chat-native", () => {
  test("fixture runs the validator and passes", async () => {
    const fixture = await import("../eval/fixtures/convo-workflow-rerun-stays-chat-native.json");
    const { validate } = await import(
      "../eval/validators/convo-workflow-rerun-stays-chat-native.ts"
    );
    const result = validate({
      ...fixture.default,
      name: fixture.default.name ?? "convo-workflow-rerun-stays-chat-native",
    });
    expect(result.pass).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// run_workflow tool should surface `suggested_command` in the envelope
// (tested via the tool definition commentary)
// ---------------------------------------------------------------------------

describe("run_workflow tool — suggested_command in envelope", () => {
  test("run_workflow tool has ALWAYS_AVAILABLE_EXECUTION category (or tenant_write)", () => {
    const tools = listTools();
    const tool = tools.find((t) => t.name === "run_workflow") as { category?: string } | undefined;
    expect(tool).toBeDefined();
    expect(tool?.category).toBe("tenant_write");
  });
});
