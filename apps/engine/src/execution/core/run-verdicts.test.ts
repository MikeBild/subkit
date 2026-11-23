import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import type { RunOptions, RunResult } from "../types.ts";
import {
  allowsSensitiveMetadataPreview,
  defaultCallerOrigin,
  executionAuditOutcome,
  forEachBodyEmptyWarning,
  heldPreviewWarning,
  refusesSensitiveConversation,
  runResultError,
  sensitiveOutputSchemaCheck,
  sensitiveRunUnsupported,
} from "./run.ts";
import { EXECUTION_STATUSES } from "./status.ts";

const FC = { seed: 20261106, numRuns: 200 } as const;

describe("loop body empty warnings", () => {
  test("for_each warning pluralises the iteration count", () => {
    expect(forEachBodyEmptyWarning("fe", 1)).toStrictEqual({
      code: "loop_body_empty",
      identifier: "fe",
      message:
        'for_each step "fe" ran 1 iteration but no iteration produced productive output — every result was null / [] / {}',
      step_key: "fe",
      details: {
        iterations: 1,
        productive_iterations: 0,
        scope_shape: "$scope.fe.data is an array of 1 iteration objects",
      },
    });
    expect(forEachBodyEmptyWarning("fe", 2).message).toBe(
      'for_each step "fe" ran 2 iterations but no iteration produced productive output — every result was null / [] / {}',
    );
  });
});

describe("heldPreviewWarning", () => {
  type Summary = RunResult["steps"][number];
  const summary = (over: Partial<Summary>): Summary => ({
    step_key: "s",
    step_index: 0,
    kind: "request",
    status: "succeeded",
    duration_ms: 0,
    retry_count: 0,
    error: null,
    ...over,
  });

  test("names held writes and skipped dependents", () => {
    const warning = heldPreviewWarning([
      summary({
        step_key: "w1",
        held: true,
        held_request: { method: "POST", url: "https://x", headers_redacted: {}, body: null },
      }),
      summary({ step_key: "w2", held: true }),
      summary({
        step_key: "d1",
        status: "skipped",
        error: { code: "skipped_dependency_held", message: "m" },
      }),
      summary({ step_key: "o1", status: "skipped", error: { code: "skipped", message: "m" } }),
      summary({ step_key: "o2", status: "skipped" }),
      summary({ step_key: "o3", error: { code: "skipped_dependency_held", message: "m" } }),
    ]);
    expect(warning).toStrictEqual({
      code: "held_preview_no_writes",
      message:
        "Preview run (hold_writes): 2 write step(s) held and 1 dependent step(s) skipped — NOTHING was written to any external system. The returned output is from upstream read/transform steps only.",
      step_key: "$holds",
      details: {
        held_steps: ["w1", "w2"],
        skipped_steps: ["d1"],
        would_write: [
          { step: "w1", method: "POST", url: "https://x" },
          { step: "w2", method: null, url: null },
        ],
      },
    });
  });

  test("without held steps the writes were held in called workflows", () => {
    expect(heldPreviewWarning([summary({})])).toStrictEqual({
      code: "held_preview_no_writes",
      message:
        "Preview run (hold_writes): writes held in called workflows — NOTHING was written to any external system. The returned output is from upstream read/transform steps only.",
      step_key: "$holds",
      details: { held_steps: [], skipped_steps: [], would_write: [] },
    });
  });
});

describe("final verdicts", () => {
  test("sensitiveOutputSchemaCheck maps the contract verdict", () => {
    expect(sensitiveOutputSchemaCheck(false, "passed")).toBe("not_defined");
    expect(sensitiveOutputSchemaCheck(true, "passed")).toBe("passed");
    expect(sensitiveOutputSchemaCheck(true, "violated")).toBe("failed");
    expect(sensitiveOutputSchemaCheck(true, "none")).toBe("not_run");
  });

  test("executionAuditOutcome only marks aborted runs as aborted", () => {
    expect(executionAuditOutcome("succeeded")).toStrictEqual({
      kind: "completed",
      result: "success",
    });
    expect(executionAuditOutcome("aborted")).toStrictEqual({ kind: "aborted", result: "error" });
    expect(executionAuditOutcome("failed")).toStrictEqual({ kind: "completed", result: "error" });
  });

  test("property: only succeeded audits as success", () => {
    fc.assert(
      fc.property(fc.constantFrom(...EXECUTION_STATUSES), (status) => {
        const audit = executionAuditOutcome(status);
        expect(audit.result === "success").toBe(status === "succeeded");
        expect(audit.kind === "aborted").toBe(status === "aborted");
      }),
      FC,
    );
  });

  test("runResultError prefers a trimmed validation error", () => {
    const last = { code: "l", message: "last" };
    const validation = { code: "v", message: "val", details: 1 };
    expect(runResultError(validation, last)).toStrictEqual({
      code: "v",
      message: "val",
    });
    expect(runResultError(null, last)).toBe(last);
    expect(runResultError(null, null)).toBeNull();
  });
});

describe("sensitive admission decisions", () => {
  const preview = {
    sensitive_metadata_preview: true,
    hold_writes: true,
  } satisfies RunOptions;

  test("metadata preview needs every precondition", () => {
    expect(allowsSensitiveMetadataPreview(preview, "sensitive", "draft")).toBe(true);
    expect(
      allowsSensitiveMetadataPreview(
        { ...preview, sensitive_metadata_preview: false },
        "sensitive",
        "draft",
      ),
    ).toBe(false);
    expect(allowsSensitiveMetadataPreview(preview, undefined, "draft")).toBe(false);
    expect(allowsSensitiveMetadataPreview(preview, "sensitive", "saved")).toBe(false);
    expect(
      allowsSensitiveMetadataPreview({ ...preview, hold_writes: false }, "sensitive", "draft"),
    ).toBe(false);
    expect(
      allowsSensitiveMetadataPreview(
        { ...preview, existing_execution_id: "e" },
        "sensitive",
        "draft",
      ),
    ).toBe(false);
    expect(
      allowsSensitiveMetadataPreview({ ...preview, tool_approval_id: "t" }, "sensitive", "draft"),
    ).toBe(false);
  });

  test("sensitive output stays out of conversations unless previewed", () => {
    expect(
      refusesSensitiveConversation({ sensitive_metadata_preview: true }, "sensitive", true),
    ).toBe(false);
    expect(
      refusesSensitiveConversation({ sensitive_metadata_preview: true }, undefined, false),
    ).toBe(true);
    expect(refusesSensitiveConversation({ request_source: "chat" }, "sensitive", false)).toBe(true);
    expect(refusesSensitiveConversation({ request_source: "chat" }, "sensitive", true)).toBe(false);
    expect(refusesSensitiveConversation({ request_source: "api" }, "sensitive", false)).toBe(false);
    expect(refusesSensitiveConversation({ request_source: "chat" }, undefined, false)).toBe(false);
  });

  test("sensitive runs refuse state, event waits, approvals and fixtures", () => {
    expect(sensitiveRunUnsupported([{ kind: "wait_for_event" }], {})).toBe(true);
    expect(sensitiveRunUnsupported([{ kind: "request", state_write: {} }], {})).toBe(true);
    expect(sensitiveRunUnsupported([{ kind: "request", state_read: {} }], {})).toBe(true);
    expect(
      sensitiveRunUnsupported([{ kind: "request" }, { kind: "transform", state_write: {} }], {}),
    ).toBe(false);
    expect(sensitiveRunUnsupported([], { tool_approval_id: "t" })).toBe(true);
    expect(sensitiveRunUnsupported([], { step_output_fixtures: {} })).toBe(true);
    expect(sensitiveRunUnsupported([], {})).toBe(false);
  });

  test("defaultCallerOrigin trusts a fresh principal run only", () => {
    const principal = {} as NonNullable<RunOptions["principal"]>;
    expect(defaultCallerOrigin({ caller_origin: "trusted_system", principal })).toBe(
      "trusted_system",
    );
    expect(defaultCallerOrigin({ principal })).toBe("principal");
    expect(defaultCallerOrigin({ principal, existing_execution_id: "e" })).toBe("unknown");
    expect(defaultCallerOrigin({})).toBe("unknown");
  });

  test("property: metadata preview is the conjunction of its preconditions", () => {
    fc.assert(
      fc.property(
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.option(fc.constantFrom("", "e"), { nil: undefined }),
        fc.option(fc.constantFrom("", "t"), { nil: undefined }),
        (smp, sensitive, draft, hold, existing, approval) => {
          const opts: RunOptions = {
            sensitive_metadata_preview: smp,
            hold_writes: hold,
            ...(existing !== undefined ? { existing_execution_id: existing } : {}),
            ...(approval !== undefined ? { tool_approval_id: approval } : {}),
          };
          const allowed = allowsSensitiveMetadataPreview(
            opts,
            sensitive ? "sensitive" : undefined,
            draft ? "draft" : "saved",
          );
          expect(allowed).toBe(smp && sensitive && draft && hold && !existing && !approval);
          if (allowed)
            expect(
              refusesSensitiveConversation(
                { ...opts, request_source: "chat" },
                "sensitive",
                allowed,
              ),
            ).toBe(false);
        },
      ),
      FC,
    );
  });
});
