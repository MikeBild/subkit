import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "core", "tool-invoke.ts");

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

  test("validate_draft is NOT exempt from the repeat cap", () => {
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
