import {
  formatOperatorQuirks,
  selectOperatorQuirkCategories,
} from "../../src/llm/core/context-assembler.ts";
import type { AuthoringPromptHint } from "../../src/llm/types.ts";
import type { FixtureRecord, ValidationResult } from "../runner.ts";

function hint(stage: AuthoringPromptHint["stage"]): AuthoringPromptHint {
  return {
    mode: "AUTHORING",
    stage,
    lifecycle_state: "draft_only",
    active_target: { kind: "workflow", lifecycle_state: "draft_only" },
    blocked_by: [],
    next_required_action: null,
    next_suggested_tool: null,
    checkpoints: [],
    latest_execution: null,
    latest_diagnosis: null,
  } as unknown as AuthoringPromptHint;
}

export function validate(fixture: FixtureRecord): ValidationResult {
  const quirks = (fixture.input as { quirks: Record<string, string> }).quirks;
  const fails: string[] = [];

  // Workflow-validated turn (transform-shaped). Only schema-related
  // categories should land in the rendered block.
  const transformCats = selectOperatorQuirkCategories(hint("workflow_validated"), false);
  const transformBlock = formatOperatorQuirks("c", "C", quirks, transformCats);
  if (!transformBlock) {
    fails.push("transform turn produced empty block (expected schema slot)");
  } else {
    if (!transformBlock.includes("SCHEMA_QUIRK_BODY")) {
      fails.push("transform turn missing schema quirk");
    }
    for (const banned of ["AUTH_QUIRK_BODY", "PAG_QUIRK_BODY", "RL_QUIRK_BODY"]) {
      if (transformBlock.includes(banned)) {
        fails.push(`transform turn leaked ${banned}`);
      }
    }
  }

  // Workflow-draft-started turn (request-shaped). schema must NOT appear.
  const requestCats = selectOperatorQuirkCategories(hint("workflow_draft_started"), false);
  const requestBlock = formatOperatorQuirks("c", "C", quirks, requestCats);
  if (!requestBlock) {
    fails.push("request turn produced empty block (expected auth+pagination+rate_limit+general)");
  } else {
    for (const banned of ["SCHEMA_QUIRK_BODY"]) {
      if (requestBlock.includes(banned)) {
        fails.push(`request turn leaked ${banned}`);
      }
    }
    for (const expected of ["AUTH_QUIRK_BODY", "PAG_QUIRK_BODY", "RL_QUIRK_BODY"]) {
      if (!requestBlock.includes(expected)) {
        fails.push(`request turn missing ${expected}`);
      }
    }
  }

  // Failure-recovery turn — overrides stage; expects error_handling + schema + general.
  const recoveryCats = selectOperatorQuirkCategories(hint("workflow_validated"), true);
  const recoveryBlock = formatOperatorQuirks("c", "C", quirks, recoveryCats);
  if (!recoveryBlock?.includes("ERR_QUIRK_BODY")) {
    fails.push("recovery turn missing error_handling quirk");
  }

  // Token-budget assertion: rendering only one slot must be strictly
  // smaller than rendering all six.
  const fullCats = [
    "auth",
    "pagination",
    "rate_limit",
    "schema",
    "error_handling",
    "general",
  ] as const;
  const fullBlock = formatOperatorQuirks("c", "C", quirks, fullCats);
  if (!fullBlock || !transformBlock || transformBlock.length >= fullBlock.length) {
    fails.push("transform-only slice not smaller than full block — picker is a no-op");
  }

  if (fails.length > 0) return { pass: false, reason: fails.join("; ") };
  return { pass: true };
}
