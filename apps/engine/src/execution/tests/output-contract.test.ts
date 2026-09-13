// Workflow output contract (Fix 11).
//
// Unit layer: the shared Ajv validator reports field-level
// `$output/...` paths and refuses schemas that don't compile.
//
// Integration layer: a LIVE run whose final output violates the
// definition's `output_schema` still SUCCEEDS — the violation rides
// `RunResult.warnings` as a non-blocking `output_contract_violation`
// with the field paths in `details.violations`. (The blocking behavior
// lives in dry_run_workflow and is covered by the conversations-layer
// test.)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { runExecution } from "../engine.ts";
import {
  checkOutputContract,
  compileOutputContractSchema,
  summarizeViolations,
} from "../output-contract.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

const CONTRACT = {
  type: "object",
  properties: {
    total: { type: "number" },
    items: { type: "array" },
  },
  required: ["total", "items"],
  // Unknown keywords must be tolerated (strict-but-lenient): LLM-
  // authored schemas routinely carry annotations.
  examples: [{ total: 1, items: [] }],
};

describe("checkOutputContract — field-level paths", () => {
  test("missing required fields are reported at $output/<field>", () => {
    const check = checkOutputContract({ count: 1 }, CONTRACT);
    if (!check.ok) throw new Error("schema should compile");
    expect(check.valid).toBe(false);
    if (check.valid) throw new Error("unreachable");
    const paths = check.violations.map((v) => v.path);
    expect(paths).toContain("$output/total");
    expect(paths).toContain("$output/items");
  });

  test("type mismatches carry the nested instance path", () => {
    const check = checkOutputContract({ total: "one", items: [{ n: 1 }] }, CONTRACT);
    if (!check.ok || check.valid) throw new Error("expected violations");
    expect(check.violations.map((v) => v.path)).toContain("$output/total");
    expect(summarizeViolations(check.violations)).toContain("$output/total");
  });

  test("a conforming output validates", () => {
    const check = checkOutputContract({ total: 2, items: ["a"] }, CONTRACT);
    expect(check.ok && check.valid).toBe(true);
  });

  test("non-object outputs validate against array schemas (contract is not object-only)", () => {
    const check = checkOutputContract([1, 2], {
      type: "array",
      items: { type: "number" },
    });
    expect(check.ok && check.valid).toBe(true);
  });
});

describe("compileOutputContractSchema — validator gate", () => {
  test("rejects a schema Ajv cannot compile", () => {
    const result = compileOutputContractSchema({ type: 123 });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error.length).toBeGreaterThan(0);
  });

  test("accepts a minimal object schema (unknown keywords tolerated)", () => {
    expect(compileOutputContractSchema(CONTRACT)).toEqual({ ok: true });
  });
});

describe("live run — output_schema violation is a NON-blocking warning", () => {
  let ctx: EngineTestCtx;

  beforeAll(async () => {
    ctx = await createEngineCtx("output-contract");
  });

  afterAll(async () => {
    await ctx.cleanup();
  });

  test("mismatching final output: run succeeds, output_contract_violation warning recorded with paths", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "contract-mismatch",
      steps: [
        {
          kind: "transform",
          id: "shape",
          language: "javascript",
          expression: "return { count: 1 };",
        },
      ],
      output_schema: CONTRACT,
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    // NON-blocking: the live run is still a success.
    expect(result.status).toBe("succeeded");
    expect(result.error).toBeNull();
    const warning = (result.warnings ?? []).find((w) => w.code === "output_contract_violation");
    expect(warning).toBeDefined();
    expect(warning?.step_key).toBe("$output");
    expect(warning?.message).toContain("$output/total");
    const violations = (warning!.details as { violations?: Array<{ path: string }> } | undefined)
      ?.violations;
    expect(violations?.map((v) => v.path)).toContain("$output/items");
  });

  test("conforming final output (via output_transform): no contract warning", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "contract-pass",
      steps: [
        {
          kind: "transform",
          id: "shape",
          language: "javascript",
          expression: "return { count: 2 };",
        },
      ],
      // The contract validates the FINAL output — post output_transform.
      output_transform: "{ 'total': count, 'items': [] }",
      output_schema: CONTRACT,
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(
      (result.warnings ?? []).find((w) => w.code === "output_contract_violation"),
    ).toBeUndefined();
    expect(result.output).toEqual({ total: 2, items: [] });
  });
});
