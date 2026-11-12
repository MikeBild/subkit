import { describe, expect, test } from "bun:test";
import { decideArgsRepeat } from "../../core/tool-invoke.ts";

describe("sdk-wrap · per-tool repeat-cap exemptions", () => {
  for (const toolName of [
    "dry_run_workflow",
    "dry_run_step",
    "dry_run_transform",
    "validate_connector_draft",
    "inspect_workflow_draft",
    "inspect_workflow",
    "inspect_connector_draft",
    "inspect_authoring_context",
    "inspect_execution_step",
  ]) {
    test(`${toolName} is exempt from the repeat cap at runtime`, () => {
      expect(
        decideArgsRepeat({
          inner: { name: toolName, category: "tenant_write" },
          argsHash: "same",
          toolArgsRepeat: { hash: "same", count: 99 },
          lastExecutionSuccess: { tool: toolName, args_hash: "same", output: { cached: true } },
        }),
      ).toMatchObject({ isReadOnly: true, repeatCount: 0, toolArgsRepeat: null, tripped: false });
    });
  }

  test("validate_draft is NOT exempt from the repeat cap", () => {
    expect(
      decideArgsRepeat({
        inner: { name: "validate_draft", category: "tenant_write" },
        argsHash: "same",
        toolArgsRepeat: { hash: "same", count: 2 },
        lastExecutionSuccess: null,
      }),
    ).toMatchObject({ isReadOnly: false, repeatCount: 3, tripped: true });
  });
});
