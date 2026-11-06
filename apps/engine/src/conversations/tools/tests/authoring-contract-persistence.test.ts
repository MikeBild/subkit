import { describe, expect, test } from "bun:test";
import { createEmptyDraftDocument } from "../../authoring-state/index.ts";
import {
  buildDraftMutationPayload,
  buildGateError,
  buildPersistencePayload,
} from "../authoring-contract.ts";

function makeDraft() {
  return createEmptyDraftDocument();
}

describe("buildPersistencePayload", () => {
  test("returns persistence: 'saved' for a workflow resource", () => {
    const draft = makeDraft();
    const result = buildPersistencePayload(draft, {
      resource_kind: "workflow",
      resource_id: "wf-test-id",
      version_id: "v-001",
    });
    expect(result.persistence).toBe("saved");
  });

  test("returns persistence: 'saved' for a connector resource", () => {
    const draft = makeDraft();
    const result = buildPersistencePayload(draft, {
      resource_kind: "connector",
      resource_id: "con-test-id",
    });
    expect(result.persistence).toBe("saved");
  });

  test("echoes the resource_kind and resource_id passed in", () => {
    const draft = makeDraft();
    const result = buildPersistencePayload(draft, {
      resource_kind: "workflow",
      resource_id: "wf-round-trip",
      version_id: "v-999",
    });
    expect(result.resource_kind).toBe("workflow");
    expect(result.resource_id).toBe("wf-round-trip");
    expect(result.version_id).toBe("v-999");
  });

  test("version_id defaults to null when not supplied", () => {
    const draft = makeDraft();
    const result = buildPersistencePayload(draft, {
      resource_kind: "connector",
      resource_id: "con-no-version",
    });
    expect(result.version_id).toBeNull();
  });
});

describe("buildGateError", () => {
  test("returns persistence: 'draft_only' by default", () => {
    const draft = makeDraft();
    const result = buildGateError(draft, {
      error_code: "GATE_TEST",
      message: "test gate error",
    });
    expect(result.persistence).toBe("draft_only");
  });

  test("extra.persistence override wins over the default 'draft_only'", () => {
    const draft = makeDraft();
    const result = buildGateError(draft, {
      error_code: "GATE_OVERRIDE",
      message: "override test",
      extra: { persistence: "saved" },
    });
    expect((result as Record<string, unknown>).persistence).toBe("saved");
  });

  test("extra fields other than persistence are included in the output", () => {
    const draft = makeDraft();
    const result = buildGateError(draft, {
      error_code: "GATE_EXTRA",
      message: "extra test",
      extra: { custom_hint: "do this instead" },
    });
    expect((result as Record<string, unknown>).custom_hint).toBe("do this instead");
    expect(result.persistence).toBe("draft_only");
  });

  test("always sets recoverable: true", () => {
    const draft = makeDraft();
    const result = buildGateError(draft, {
      error_code: "GATE_RECOVERABLE",
      message: "must be recoverable",
    });
    expect(result.recoverable).toBe(true);
  });

  test("error_code is echoed in both error and error_code fields", () => {
    const draft = makeDraft();
    const result = buildGateError(draft, {
      error_code: "MY_ERROR",
      message: "check codes",
    });
    expect(result.error).toBe("MY_ERROR");
    expect(result.error_code).toBe("MY_ERROR");
  });
});

test("mutation and gate summaries retain diagnosis status without duplicating large response bodies", () => {
  const draft = makeDraft();
  if (!draft.state) throw new Error("expected normalized state");
  draft.state.latest_diagnosis = {
    execution_id: "execution-one",
    recorded_at: "2026-01-01T00:00:00.000Z",
    reason: "Inspect failure",
    warning_sources: [],
    steps: [
      {
        step_key: "read",
        kind: "request",
        status: "failed",
        duration_ms: 1,
        error: { code: "upstream_failed" },
        output_preview: "PRIVATE_RESPONSE".repeat(30000),
        request_meta: { body: "PRIVATE_REQUEST".repeat(10000) },
      },
    ],
  };
  for (const payload of [
    buildGateError(draft, { error_code: "patch_invalid", message: "Fix the field" }),
    buildDraftMutationPayload(draft),
  ]) {
    const text = JSON.stringify(payload);
    expect(text.length).toBeLessThan(12000);
    expect(text).toContain("upstream_failed");
    expect(text).not.toContain("PRIVATE_RESPONSE");
    expect(text).not.toContain("PRIVATE_REQUEST");
    expect(text).toContain("checkpoints");
  }
  expect(draft.state.latest_diagnosis.steps[0]?.output_preview).toContain("PRIVATE_RESPONSE");
});
