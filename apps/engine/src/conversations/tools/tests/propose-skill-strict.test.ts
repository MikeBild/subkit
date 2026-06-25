// Property tests for the strict / inputExamples opt-in.
//
// `proposeSkillTool` opts into provider-native strict mode because its
// input schema is all concrete types. The two sibling authoring tools
// (build_workflow, propose_step) keep strict OFF because their schemas
// include `z.record(z.unknown())` which strict mode does not accept —
// asserted here so a future refactor that flips strict on those tools
// without also tightening the schema fails fast.

import { describe, expect, it } from "bun:test";
import type { ZodType } from "zod";
import { zodToJsonSchema7 } from "../../../mcp/json-schema.ts";
import { buildWorkflowTool } from "../build-workflow.ts";
import { proposeSkillTool } from "../propose-skill.ts";
import { proposeStepTool } from "../propose-step.ts";
import { toInputExamples } from "../sdk-wrap/invoke.ts";

// Walk a JSON-Schema-7 object tree and return true iff any subschema is
// an `object` whose `additionalProperties` admits anything — i.e. `true`,
// absent, or an empty-object schema `{}` (the shape Zod v4 produces for
// `z.record(z.unknown())`). Provider strict mode (Anthropic JSON-mode,
// OpenAI structured outputs) requires every object to forbid additional
// properties; a single permissive node anywhere makes the tool strict-
// incompatible.
function isUnrestrictedAdditional(v: unknown): boolean {
  if (v === undefined || v === true) return true;
  if (v !== null && typeof v === "object") {
    // An empty object schema `{}` matches anything, same as `true`.
    return Object.keys(v as Record<string, unknown>).length === 0;
  }
  return false;
}

function hasUnrestrictedObject(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const obj = node as Record<string, unknown>;
  if (obj.type === "object" && isUnrestrictedAdditional(obj.additionalProperties)) return true;
  for (const v of Object.values(obj)) {
    if (Array.isArray(v)) {
      for (const item of v) if (hasUnrestrictedObject(item)) return true;
    } else if (hasUnrestrictedObject(v)) {
      return true;
    }
  }
  return false;
}

const toJsonSchema = (schema: unknown) => zodToJsonSchema7(schema as ZodType) as unknown;

describe("strict + inputExamples opt-in", () => {
  it("propose_skill opts into strict mode", () => {
    expect(proposeSkillTool.strict).toBe(true);
  });

  it("propose_skill ships an example_input", () => {
    expect(proposeSkillTool.example_input).toBeDefined();
    expect(typeof proposeSkillTool.example_input).toBe("object");
    expect((proposeSkillTool.example_input as Record<string, unknown>).scope).toBe("global");
  });

  it("propose_skill example_input parses against its inputSchema", () => {
    const parsed = proposeSkillTool.inputSchema.safeParse(proposeSkillTool.example_input);
    expect(parsed.success).toBe(true);
  });

  it("build_workflow keeps strict off (uses z.record(z.unknown()))", () => {
    expect(buildWorkflowTool.strict).toBeUndefined();
  });

  it("propose_step keeps strict off (uses z.record(z.unknown()))", () => {
    expect(proposeStepTool.strict).toBeUndefined();
  });

  // Structural invariant: prove the contrapositive of the strict-off
  // decision. If a future refactor tightens
  // build_workflow / propose_step to drop `z.record(z.unknown())`,
  // these tests fail and remind the next agent that strict mode is
  // now an option.
  it("build_workflow inputSchema contains an unrestricted object (strict-incompat)", () => {
    expect(hasUnrestrictedObject(toJsonSchema(buildWorkflowTool.inputSchema))).toBe(true);
  });

  it("propose_step inputSchema contains an unrestricted object (strict-incompat)", () => {
    expect(hasUnrestrictedObject(toJsonSchema(proposeStepTool.inputSchema))).toBe(true);
  });

  it("propose_skill inputSchema is fully restricted (strict-compatible)", () => {
    expect(hasUnrestrictedObject(toJsonSchema(proposeSkillTool.inputSchema))).toBe(false);
  });

  // Regression in v4.6.0: AI SDK 6 strict-validates `inputExamples`
  // against the JSON-Schema projection of `inputSchema`. The projection
  // unconditionally seals every object with `additionalProperties:
  // false` — including `z.record(...)` values, which legitimately
  // accept any string key. The mismatch made Anthropic reject every
  // conversation turn with `tools.N.custom: Example at index 0 is
  // invalid: False schema does not allow <value>`. The fix is to stop
  // emitting the `inputExamples` channel; the model still sees the
  // example via the `<example>` block compileDescription appends to
  // the tool description. The four tests below pin the current
  // contract: `toInputExamples` is a no-op until upstream record
  // projection is fixed AND every tool's example survives the strict
  // JSON-Schema validation.
  it("toInputExamples is a no-op for any input (regression suppressor)", () => {
    expect(toInputExamples({ scope: "global", title: "x" })).toEqual({});
    expect(toInputExamples(undefined)).toEqual({});
    expect(toInputExamples(proposeSkillTool.example_input)).toEqual({});
  });
});
