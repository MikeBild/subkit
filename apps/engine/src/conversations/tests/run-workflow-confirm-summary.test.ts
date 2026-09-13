// run_workflow's policy-gate confirm summary should carry workflow
// context (name + environment + last preview blurb), NOT just the
// generic "Confirm run_workflow (policy: confirm_before_execution)".
// Pre-fix the operator clicking "approve" on the elicitation card
// saw zero context about what they were approving.
//
// We assert the source-level wiring (the buildPolicyGateSummary
// closure exists and references the run_workflow shape) plus a
// negative check that the old generic string isn't the only summary
// path anymore.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

// The buildPolicyGateSummary closure lives in
// `conversations/tools/sdk-wrap/invoke.ts`.
const SRC = join(import.meta.dir, "..", "tools", "sdk-wrap", "invoke.ts");

describe("policy-gate confirm summary · run_workflow", () => {
  const body = readFileSync(SRC, "utf-8");

  test("buildPolicyGateSummary closure is wired in", () => {
    expect(body).toContain("buildPolicyGateSummary");
  });

  test("run_workflow branch references the workflow name + env", () => {
    expect(body).toMatch(/inner\.name === "run_workflow"/);
    expect(body).toContain("Run workflow");
    expect(body).toMatch(/last preview/);
  });

  test("createElicitation receives policyGateSummary, not the literal generic string", () => {
    expect(body).toContain("summary: policyGateSummary");
    // The old generic string is now ONLY a fallback inside the
    // closure — there must be no remaining call site that hard-
    // codes it as the elicitation summary.
    const hardcodeOccurrences = body.match(
      /summary: `Confirm \$\{inner\.name\} \(policy: \$\{resolvedMode\}\)`/g,
    );
    // The fallback inside the closure counts once; there must be
    // no other call site using the literal.
    expect((hardcodeOccurrences ?? []).length).toBeLessThanOrEqual(1);
  });
});
