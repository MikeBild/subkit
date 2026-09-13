// Unit tests for `classifyPreviewFailure` and `traceFailedWithRuntimeDataError`.
// Pure functions — no DB, no network.
//
// The commit gate reacts to the classification:
//   - `config_invalid` / `unknown` → block even with force_commit
//   - `runtime_data`               → allow force_commit:true

import { describe, expect, it } from "bun:test";

import type { DraftDocument, WorkflowDraftStepPreview } from "../types.ts";
import {
  classifyPreviewFailure,
  traceFailedWithRuntimeDataError,
} from "./preview-failure-class.ts";

function failedPreview(
  traces: WorkflowDraftStepPreview[],
  warnings: Array<{ code: string }> = [],
): DraftDocument["latest_preview"] {
  return {
    ok: false,
    summary: "failed",
    step_traces: traces,
    warnings,
  };
}

function trace(
  opts: Partial<WorkflowDraftStepPreview> & { step_id?: string } = {},
): WorkflowDraftStepPreview {
  return {
    step_id: opts.step_id ?? "step1",
    kind: "request",
    status: opts.status ?? "failed",
    ...opts,
  };
}

describe("classifyPreviewFailure", () => {
  it("returns 'unknown' for a null/missing preview", () => {
    expect(classifyPreviewFailure(null)).toBe("unknown");
    expect(classifyPreviewFailure(undefined)).toBe("unknown");
  });

  it("returns 'runtime_data' for a step trace with HTTP 404", () => {
    const result = classifyPreviewFailure(
      failedPreview([trace({ status: "failed", request_meta: { status: 404 } })]),
    );
    expect(result).toBe("runtime_data");
  });

  it("returns 'runtime_data' for a step trace with HTTP 410 (Gone)", () => {
    const result = classifyPreviewFailure(
      failedPreview([trace({ status: "failed", request_meta: { status: 410 } })]),
    );
    expect(result).toBe("runtime_data");
  });

  // "proof before proposal": an auth rejection (401/403/auth_failed) is
  // negative proof the workflow never authenticated against the destination.
  // It must NOT be force-committable the way a 404/410 (record gone) is — so
  // it classifies as `unknown`, which the commit gate blocks even with force.
  it("returns 'unknown' (not force-committable) for a step trace with HTTP 401", () => {
    const result = classifyPreviewFailure(
      failedPreview([trace({ status: "failed", request_meta: { status: 401 } })]),
    );
    expect(result).toBe("unknown");
  });

  it("returns 'unknown' (not force-committable) for a step trace with HTTP 403", () => {
    const result = classifyPreviewFailure(
      failedPreview([trace({ status: "failed", request_meta: { status: 403 } })]),
    );
    expect(result).toBe("unknown");
  });

  it("returns 'unknown' (not force-committable) for a step with error_code=auth_failed", () => {
    const result = classifyPreviewFailure(
      failedPreview([trace({ status: "error", error_code: "auth_failed" })]),
    );
    expect(result).toBe("unknown");
  });

  it("returns 'runtime_data' when a warning has code=http_404", () => {
    const result = classifyPreviewFailure(failedPreview([], [{ code: "http_404" }]));
    expect(result).toBe("runtime_data");
  });

  it("returns 'config_invalid' for unresolved_identifier error_code", () => {
    const result = classifyPreviewFailure(
      failedPreview([trace({ status: "error", error_code: "unresolved_identifier" })]),
    );
    expect(result).toBe("config_invalid");
  });

  it("returns 'config_invalid' for workflow_cycle_detected error_code", () => {
    const result = classifyPreviewFailure(
      failedPreview([trace({ status: "error", error_code: "workflow_cycle_detected" })]),
    );
    expect(result).toBe("config_invalid");
  });

  it("config_invalid dominates runtime_data when both appear in the same preview", () => {
    // One step has a 404 (runtime), another has an unresolved reference (config).
    // config_invalid must win — block even force_commit.
    const result = classifyPreviewFailure(
      failedPreview([
        trace({ step_id: "s1", status: "failed", request_meta: { status: 404 } }),
        trace({ step_id: "s2", status: "error", error_code: "unresolved_identifier" }),
      ]),
    );
    expect(result).toBe("config_invalid");
  });

  it("returns 'config_invalid' when warning code contains 'validation'", () => {
    const result = classifyPreviewFailure(failedPreview([], [{ code: "jsonata_parse_error" }]));
    expect(result).toBe("config_invalid");
  });

  it("returns 'unknown' when there are no traces and no classifiable warnings", () => {
    const result = classifyPreviewFailure(failedPreview([]));
    expect(result).toBe("unknown");
  });

  it("returns 'unknown' when error_code is unrecognised and no HTTP status is present", () => {
    const result = classifyPreviewFailure(
      failedPreview([trace({ status: "failed", error_code: "some_unknown_code" })]),
    );
    expect(result).toBe("unknown");
  });
});

describe("traceFailedWithRuntimeDataError", () => {
  it("returns true for a failed trace with HTTP 404 in request_meta", () => {
    expect(
      traceFailedWithRuntimeDataError(trace({ status: "failed", request_meta: { status: 404 } })),
    ).toBe(true);
  });

  it("returns true for an error trace with HTTP 410 in request_meta", () => {
    expect(
      traceFailedWithRuntimeDataError(trace({ status: "error", request_meta: { status: 410 } })),
    ).toBe(true);
  });

  it("returns false for a succeeded trace even with a 404-like status", () => {
    // The status fields are only meaningful on failed/error traces.
    expect(
      traceFailedWithRuntimeDataError(
        trace({ status: "succeeded", request_meta: { status: 404 } }),
      ),
    ).toBe(false);
  });

  it("returns false for a failed trace with error_code=auth_failed (auth is not a force/exempt signal)", () => {
    // Auth failures are excluded from the runtime-data set on purpose — a
    // transform referencing a step that never authenticated has no proven
    // shape to author against, so the gate must hold rather than exempt it.
    expect(
      traceFailedWithRuntimeDataError(trace({ status: "failed", error_code: "auth_failed" })),
    ).toBe(false);
  });

  it("returns false for a failed trace with no recognisable runtime signal", () => {
    expect(
      traceFailedWithRuntimeDataError(
        trace({ status: "failed", error_code: "unresolved_identifier" }),
      ),
    ).toBe(false);
  });
});
