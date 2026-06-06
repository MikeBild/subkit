// Targeted tests for the concrete-alternatives generator used by the
// consecutive-failures cap (Adoption D). The helper itself lives in
// `sdk-wrap/error-recovery-hints.ts`; this file also asserts that the
// catalogue stays in sync with the error codes any tool actually
// surfaces.

import { describe, expect, it } from "bun:test";
import * as errorCodes from "../error-codes.ts";
import { buildCapAlternatives, ERROR_CODE_ALTERNATIVES } from "../sdk-wrap/error-recovery-hints.ts";

describe("buildCapAlternatives", () => {
  it("returns empty string when no failures are recorded", () => {
    expect(buildCapAlternatives(new Map())).toBe("");
  });

  it("returns empty string when the recorded error codes are unknown", () => {
    const errors = new Map([["propose_step", "some_unknown_code|boom"]]);
    expect(buildCapAlternatives(errors)).toBe("");
  });

  it("emits the concrete recovery hint for transform_authoring_requires_inspect", () => {
    const errors = new Map([
      ["update_param", "transform_authoring_requires_inspect|must inspect first"],
    ]);
    const out = buildCapAlternatives(errors);
    expect(out).toContain("transform_authoring_requires_inspect");
    expect(out).toContain("inspect_execution_step");
  });

  it("dedupes by error code when multiple tools share the same code", () => {
    const errors = new Map([
      ["propose_step", "step_invalid|foo"],
      ["update_param", "step_invalid|bar"],
    ]);
    const out = buildCapAlternatives(errors);
    // Only one bullet for the single unique error code.
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
    // Two distinct bullet points.
    expect(out.match(/^ {2}•/gm)?.length).toBe(2);
  });

  it("never trips on a malformed shape string (no '|' separator)", () => {
    const errors = new Map([["propose_step", "raw_string_no_pipe"]]);
    // Whatever happens, the function must not throw and must return a string.
    expect(typeof buildCapAlternatives(errors)).toBe("string");
  });
});

describe("ERROR_CODE_ALTERNATIVES catalogue completeness", () => {
  // S3 (round-2 review): the previous hand-maintained list was a
  // documentation drift hazard — adding a new `error_code` to any
  // tool would land green even though the cap message falls back to
  // the generic "ask the user". Now we grep the source for actual
  // `error_code: "..."` literals and assert the catalogue covers each
  // one. The catalogue is allowed to be a strict superset (some codes
  // surfaced from infrastructure don't have a meaningful "next tool"),
  // but a code shipped from a tool MUST have a hint.

  // Subset of `error_code` literals that intentionally have no
  // alternative — surfaced from infrastructure (engine, RBAC, OAuth,
  // policy, validation framework) rather than from an authoring tool
  // the model can recover from on its own. Adding to this set is a
  // deliberate choice; explain WHY in the entry.
  const EXEMPT_CODES = new Set<string>([
    // RBAC + auth surfaces — recovery is "talk to your admin", not a
    // different tool call.
    "rbac_denied",
    "credential_required",
    "unauthorized",
    "forbidden",
    "permission_denied",
    "permission_unknown",
    "writes_not_allowed",
    // Engine internals — the model can't avoid them by switching tools.
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
    "consecutive_failures_cap", // meta — fires when the cap itself trips
    "turn_loop_budget_exhausted", // meta — turn-ending signal (loop_detected / failures-cap); recovery is "end the turn", not a different tool
    // Tool-surface errors where the recovery is the same tool with
    // different args — no cross-tool alternative to recommend.
    "input_validation_failed",
    "invalid_input",
    "slug_conflict_with_live_workflow",
    "slug_conflict_with_live_connector",
    "draft_not_found",
    "no_active_draft",
    "auth_mutation_not_allowed",
    "auth_type_downgrade_blocked", // recovery is "ask the user to confirm the downgrade"
    "builtin_immutable", // can't mutate, must fork — that's an authoring decision, not a tool swap
    // Critic / policy gates — recovery is "revise based on the verdict".
    "critic_rejected",
    "destructive_skill_confirmation_required",
    "tool_unavailable_in_state",
    // Driver / connector capability gates — choose a different driver.
    "driver_not_supported_for_call_connector",
    // Credential / security violations — recovery is to redo via the
    // designated form, not a different tool.
    "credential_must_use_form",
    "credential_placeholder_leak",
    // Knowledge-source sizing — recovery is "ask the user to narrow / split".
    "knowledge_source_empty",
    "knowledge_source_too_large",
  ]);

  function findErrorCodeLiteralsInTools(): string[] {
    // Synchronous fs walk constrained to the conversations/tools tree
    // — the engine surface where the cap fires reads from
    // signals.toolLastErrorHash, populated only by tool wrap. Going
    // beyond this tree pulls in HTTP error mappers etc. that the cap
    // never sees.
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
    // Discovery must find something — otherwise the regex is broken
    // and we'd silently pass.
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
      expect(hint.length).toBeGreaterThan(20); // any meaningful hint is >20 chars
      // Catalogue keys are the same shape as the literals (lowercase + underscores).
      expect(code).toMatch(/^[a-z][a-z0-9_]+$/);
    }
  });

  // W5 (fifth review): the grep-for-literals check above misses the
  // elicitation / OAuth codes — those tools return `error_code: <CONST>`
  // referencing the `error-codes.ts` exports, not inline string literals,
  // so the `error_code:\s*['"]...['"]` regex never sees them. Pin the
  // catalogue directly against every exported constant from
  // `error-codes.ts`: each one is a structured `error_code` a tool
  // surfaces, so each MUST have a recovery hint. The module is the
  // canonical owner of these codes (see its header) — a constant added
  // there without a matching hint silently drops the cap's recovery line.
  it("has a hint for every error code exported from error-codes.ts", () => {
    const exportedCodes = Object.entries(errorCodes)
      .filter(([, v]) => typeof v === "string")
      .map(([, v]) => v as string)
      .sort();
    // Discovery sanity — error-codes.ts must export something.
    expect(exportedCodes.length).toBeGreaterThan(0);
    const missing = exportedCodes.filter((code) => !(code in ERROR_CODE_ALTERNATIVES));
    expect({
      missing_from_catalogue: missing,
      hint: "every constant exported from conversations/tools/error-codes.ts must have an entry in ERROR_CODE_ALTERNATIVES (sdk-wrap/error-recovery-hints.ts). If a code legitimately needs no hint, drop it from error-codes.ts or document the exclusion explicitly here.",
    }).toEqual({ missing_from_catalogue: [], hint: expect.any(String) });
  });
});
