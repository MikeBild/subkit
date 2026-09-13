// Unit tests for the `persistence` field on authoring payload builders.
//
// buildPersistencePayload must always emit persistence: "saved".
// buildGateError must always emit persistence: "draft_only".
// buildGateError accepts an `extra` override that wins over the default.

import { describe, expect, test } from "bun:test";

import { createEmptyDraftDocument } from "../../authoring-state.ts";
import { buildGateError, buildPersistencePayload } from "../authoring-contract.ts";

// ---------------------------------------------------------------------------
// Minimal DraftDocument fixture — mirrors the pattern used in authoring-state.test.ts
// ---------------------------------------------------------------------------

function makeDraft() {
  return createEmptyDraftDocument();
}

// ---------------------------------------------------------------------------
// buildPersistencePayload
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// buildGateError
// ---------------------------------------------------------------------------

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
    // The static return type pins `persistence` to the literal "draft_only";
    // the runtime `extra` spread overrides it. Read through a widened view so
    // the override assertion isn't blocked by the literal type.
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
    // persistence still defaults to draft_only
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
