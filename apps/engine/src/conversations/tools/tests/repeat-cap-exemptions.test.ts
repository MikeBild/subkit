// Tools whose meaningful state is the conversation DRAFT (not the
// args) must be exempt from the per-tool repeat-args cap. Pre-fix
// (session 8d152b9f 16:00:59), dry_run_workflow was capped after 3
// previews of the same draft args — even though each preview ran
// against a DIFFERENT draft state because the LLM had edited the
// draft between calls. The "args identical → spiral" heuristic is
// wrong for tools that operate on evolving state.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

// The repeat-cap exemptions live in `tools/sdk-wrap/invoke.ts`.
const SRC = join(import.meta.dir, "..", "sdk-wrap", "invoke.ts");

describe("sdk-wrap · per-tool repeat-cap exemptions", () => {
  const body = readFileSync(SRC, "utf-8");

  test("REPEAT_EXEMPT_TOOLS list exists", () => {
    expect(body).toContain("REPEAT_EXEMPT_TOOLS");
  });

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
    test(`${toolName} is exempt from the repeat cap`, () => {
      expect(body).toContain(`"${toolName}"`);
    });
  }

  // validate_draft is intentionally NOT exempt anymore. The authoring
  // context block inlines the current validation state on every turn
  // via `renderValidationStateLines`, so repeated identical
  // `validate_draft({})` calls are the loop-spiral signal the repeat
  // cap exists to catch.
  test("validate_draft is NOT exempt from the repeat cap", () => {
    // Look for the string inside the REPEAT_EXEMPT_TOOLS set body only —
    // not anywhere in the file (the rationale comment legitimately
    // mentions the name).
    const setMatch = body.match(/REPEAT_EXEMPT_TOOLS\s*=\s*new Set<string>\(\[([\s\S]*?)\]\)/);
    expect(setMatch).not.toBeNull();
    const setBody = setMatch?.[1] ?? "";
    expect(setBody).not.toContain('"validate_draft"');
  });

  test("isReadOnly accepts BOTH tenant_read AND exempt-by-name tools", () => {
    expect(body).toMatch(
      /isReadOnly\s*=\s*\n?\s*inner\.category === "tenant_read" \|\| REPEAT_EXEMPT_TOOLS\.has/,
    );
  });
});
