// Operator-debugging depth for the CLI redactor. Pre-fix
// MAX_DEPTH=4 collapsed the legitimate nesting of tool envelopes
// (build_workflow.errors[].path; propose_step.summary.checkpoints[…])
// to "[depth-exceeded]" markers — exactly what session 0a01c5f3
// surfaced as "warnings disappear before I can read them".

import { describe, expect, test } from "bun:test";

import { redact } from "./redact.ts";

describe("redact · operator-debugging depth", () => {
  test("renders a 6-level-deep tool error envelope without [depth-exceeded] markers", () => {
    const envelope = {
      tool: "build_workflow",
      output: {
        error_code: "workflow_unresolved_step_reference",
        message: "workflow references unknown step ids",
        details: {
          unresolved_references: [
            {
              step_id: "format_output",
              field: "expression",
              bad_reference: "project",
              context: "$scope.project.name",
              did_you_mean: ["projects"],
            },
          ],
        },
      },
    };
    const out = redact(envelope);
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("[depth-exceeded]");
    // The leaf path that pre-fix was hidden — the actual `did_you_mean`
    // list — must round-trip readably.
    expect(serialised).toContain("projects");
    expect(serialised).toContain("$scope.project.name");
  });

  test("still terminates on circular references (no depth blow-up)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately circular
    const a: any = { name: "a" };
    a.self = a;
    // Should not throw / hang — the secret-shape scrubber's seen-set
    // breaks the cycle.
    const out = redact(a);
    expect(typeof out).toBe("object");
  });

  test("redacts sensitive keys at every depth", () => {
    const envelope = {
      level_0: {
        level_1: {
          level_2: {
            level_3: {
              level_4: {
                level_5: {
                  api_key: "wf_live_secret_token_xyz",
                },
              },
            },
          },
        },
      },
    };
    const out = redact(envelope);
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("secret_token_xyz");
  });
});
