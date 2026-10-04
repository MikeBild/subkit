import { describe, expect, it } from "bun:test";
import * as errorCodes from "../error-codes.ts";
import { buildCapAlternatives, ERROR_CODE_ALTERNATIVES } from "../sdk-wrap/error-recovery-hints.ts";

describe("buildCapAlternatives", () => {
  it("returns empty string when no failures are recorded", () => {
    expect(buildCapAlternatives(new Map())).toBe("");
  });

  it("returns empty string when the recorded error codes are unknown", () => {
    const errors = new Map([["edit_workflow_patch", "some_unknown_code|boom"]]);
    expect(buildCapAlternatives(errors)).toBe("");
  });

  it("emits the concrete recovery hint for transform_authoring_requires_inspect", () => {
    const errors = new Map([
      ["edit_workflow_patch", "transform_authoring_requires_inspect|must inspect first"],
    ]);
    const out = buildCapAlternatives(errors);
    expect(out).toContain("transform_authoring_requires_inspect");
    expect(out).toContain("inspect_execution_step");
  });

  it("dedupes by error code when multiple tools share the same code", () => {
    const errors = new Map([
      ["edit_workflow_patch", "step_invalid|foo"],
      ["author_workflow", "step_invalid|bar"],
    ]);
    const out = buildCapAlternatives(errors);
    expect(out.match(/step_invalid/g)?.length).toBe(1);
  });

  it("renders multiple distinct codes as separate bullets", () => {
    const errors = new Map([
      ["transform_authoring", "transform_authoring_requires_inspect|hint"],
      ["request_step", "http_4xx|hint"],
    ]);
    const out = buildCapAlternatives(errors);
    expect(out).toContain("transform_authoring_requires_inspect");
    expect(out).toContain("http_4xx");
    expect(out.match(/^ {2}•/gm)?.length).toBe(2);
  });

  it("never trips on a malformed shape string (no '|' separator)", () => {
    const errors = new Map([["edit_workflow_patch", "raw_string_no_pipe"]]);
    expect(typeof buildCapAlternatives(errors)).toBe("string");
  });
});

describe("ERROR_CODE_ALTERNATIVES · authoring-gate recovery recipes", () => {
  it("draft_write_held explains the read-only preparation and approved saved-connector path", () => {
    const hint = ERROR_CODE_ALTERNATIVES.draft_write_held;
    expect(hint).toContain("before credential lookup or dispatch");
    expect(hint).toContain("read-only probe");
    expect(hint).toContain("save the connector");
    expect(hint).toContain("call_connector");
    expect(hint).toContain("human approval");
    expect(hint).toContain("Do not retry");
  });
  it("loop_authoring_requires_inspect names dry_run_workflow and the evidence-survival rule", () => {
    const hint = ERROR_CODE_ALTERNATIVES.loop_authoring_requires_inspect;
    expect(hint).toContain("dry_run_workflow");
    expect(hint).toMatch(/unchanged steps keep their evidence/i);
    expect(hint).toMatch(/definition changed since the last preview/i);
  });

  it("transform_authoring_requires_inspect names dry_run_workflow and the evidence-survival rule", () => {
    const hint = ERROR_CODE_ALTERNATIVES.transform_authoring_requires_inspect;
    expect(hint).toContain("dry_run_workflow");
    expect(hint).toMatch(/unchanged steps keep their evidence/i);
    expect(hint).toContain("inspect_execution_step");
  });

  it("preview_stale_for_referenced_step has a hint: refresh via one dry-run, other-step edits don't invalidate", () => {
    const hint = ERROR_CODE_ALTERNATIVES.preview_stale_for_referenced_step;
    expect(hint).toBeDefined();
    expect(hint).toContain("dry_run_workflow");
    expect(hint).toMatch(/edits to other steps do NOT invalidate/i);
  });

  it("step_update_invalid teaches the loop-body array form", () => {
    const hint = ERROR_CODE_ALTERNATIVES.step_update_invalid;
    expect(hint).toContain('body: ["step_id"]');
    expect(hint).toMatch(/ARRAY of step ids/i);
  });

  it(`workflow_unsupported_placeholder teaches loop-body addressing (\${item.…} / $item)`, () => {
    const hint = ERROR_CODE_ALTERNATIVES.workflow_unsupported_placeholder;
    expect(hint).toContain(`\${item.<path>}`);
    expect(hint).toContain("$item.<path>");
    expect(hint).not.toContain("item_var");
    expect(hint).toMatch(/JSONata/);
  });

  it("placeholder_unresolved teaches loop-body addressing and sibling scope refs", () => {
    const hint = ERROR_CODE_ALTERNATIVES.placeholder_unresolved;
    expect(hint).toBeDefined();
    expect(hint).toContain(`\${item.<path>}`);
    expect(hint).toContain(`\${scope.<body_step_id>.data.<field>}`);
  });
});

describe("ERROR_CODE_ALTERNATIVES catalogue completeness", () => {
  const EXEMPT_CODES = new Set<string>([
    "rbac_denied",
    "credential_required",
    "unauthorized",
    "forbidden",
    "permission_denied",
    "permission_unknown",
    "writes_not_allowed",
    "engine_internal_error",
    "execution_aborted",
    "execution_timed_out",
    "execution_cancelled",
    "step_crash",
    "state_read_failed",
    "data_selector_error",
    "output_transform_failed",
    "validation_failed",
    "run_failed",
    "consecutive_failures_cap",
    "turn_loop_budget_exhausted",
    "input_validation_failed",
    "invalid_input",
    "slug_conflict_with_live_workflow",
    "slug_conflict_with_live_connector",
    "draft_not_found",
    "no_active_draft",
    "auth_mutation_not_allowed",
    "auth_type_downgrade_blocked",
    "builtin_immutable",
    "critic_rejected",
    "destructive_skill_confirmation_required",
    "tool_unavailable_in_state",
    "driver_not_supported_for_call_connector",
    "credential_must_use_form",
    "credential_placeholder_leak",
    "knowledge_source_empty",
    "knowledge_source_too_large",
  ]);

  function findErrorCodeLiteralsInTools(): string[] {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const root = path.resolve(__dirname, "..");
    const literals = new Set<string>();
    const literalRe = /error_code:\s*['"]([a-z][a-z0-9_]+)['"]/g;
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "tests" || entry.name === "node_modules") continue;
          walk(full);
        } else if (
          entry.isFile() &&
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts")
        ) {
          const src = fs.readFileSync(full, "utf8");
          let m: RegExpExecArray | null;
          // biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
          while ((m = literalRe.exec(src)) !== null) {
            const code = m[1];
            if (code) literals.add(code);
          }
        }
      }
    };
    walk(root);
    return [...literals].sort();
  }

  it("has an entry for every error_code literal a tool surfaces (or marks it exempt)", () => {
    const found = findErrorCodeLiteralsInTools();
    expect(found.length).toBeGreaterThan(0);
    const missing = found.filter(
      (code) => !(code in ERROR_CODE_ALTERNATIVES) && !EXEMPT_CODES.has(code),
    );
    expect({
      missing_from_catalogue: missing,
      hint: "add an entry to ERROR_CODE_ALTERNATIVES in sdk-wrap/error-recovery-hints.ts, OR add the code to EXEMPT_CODES in this test with a one-line WHY.",
    }).toEqual({ missing_from_catalogue: [], hint: expect.any(String) });
  });

  it("every catalogue entry is a non-empty string", () => {
    for (const [code, hint] of Object.entries(ERROR_CODE_ALTERNATIVES)) {
      expect(typeof hint).toBe("string");
      expect(hint.length).toBeGreaterThan(20);
      expect(code).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });

  it("has a hint for every error code exported from error-codes.ts", () => {
    const exportedCodes = Object.entries(errorCodes)
      .filter(([, v]) => typeof v === "string")
      .map(([, v]) => v as string)
      .sort();
    expect(exportedCodes.length).toBeGreaterThan(0);
    const missing = exportedCodes.filter((code) => !(code in ERROR_CODE_ALTERNATIVES));
    expect({
      missing_from_catalogue: missing,
      hint: "every constant exported from conversations/tools/error-codes.ts must have an entry in ERROR_CODE_ALTERNATIVES (sdk-wrap/error-recovery-hints.ts). If a code legitimately needs no hint, drop it from error-codes.ts or document the exclusion explicitly here.",
    }).toEqual({ missing_from_catalogue: [], hint: expect.any(String) });
  });
});
