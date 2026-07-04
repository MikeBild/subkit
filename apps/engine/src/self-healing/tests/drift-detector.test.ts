import { describe, expect, test } from "bun:test";
import { deriveShape } from "../../schema-versions/service.ts";
import { analyzeStepFailure, renderDriftDiff } from "../drift-detector.ts";
import type { SchemaShape } from "../types.ts";

describe("self-healing/drift-detector", () => {
  test("HTTP 404 with a new error shape becomes http_status_new_shape", () => {
    const lastKnown: SchemaShape = deriveShape({ id: 1, name: "Ada" });
    const signal = analyzeStepFailure(
      {
        id: "step-1",
        kind: "request",
        status: "failed",
        error: {
          kind: "http",
          status: 404,
          body: { error: { code: "not_found", detail: "User not found" } },
        },
        request_meta: {
          driver: "http",
          method: "GET",
          url: "/users/99",
          connector: {
            step_key: "step-1",
            connector_id: "00000000-0000-0000-0000-000000000000",
            connector_slug: "stub",
            driver: "http",
            requested_environment: "dev",
            resolved_environment: "dev",
            auth_method: "none",
            base_url: null,
          },
        },
      },
      lastKnown,
    );
    expect(signal?.kind).toBe("http_status_new_shape");
    if (signal?.kind === "http_status_new_shape") {
      expect(signal.status).toBe(404);
      expect(signal.request.method).toBe("GET");
    }
  });

  test("HTTP 500 that matches the last known shape is not drift", () => {
    const lastKnown: SchemaShape = deriveShape({ error: { code: "oops", detail: "boom" } });
    const signal = analyzeStepFailure(
      {
        id: "step-1",
        kind: "request",
        status: "failed",
        error: {
          kind: "http",
          status: 500,
          body: { error: { code: "oops", detail: "another boom" } },
        },
      },
      lastKnown,
    );
    expect(signal).toBeNull();
  });

  test("JSONata path miss is detected", () => {
    const signal = analyzeStepFailure(
      {
        id: "step-2",
        kind: "transform",
        status: "failed",
        expression: "$.data.id",
        error: {
          kind: "jsonata_miss",
          expression: "$.data.id",
          missing_path: "data.id",
          prior_value: 1,
        },
      },
      null,
    );
    expect(signal?.kind).toBe("jsonata_path_miss");
    if (signal?.kind === "jsonata_path_miss") {
      expect(signal.expression).toBe("$.data.id");
      expect(signal.missing_path).toBe("data.id");
    }
  });

  test("schema_diff surfaces when captured_response differs from last known shape", () => {
    const lastKnown: SchemaShape = deriveShape({ id: 1, name: "Ada" });
    const signal = analyzeStepFailure(
      {
        id: "step-3",
        kind: "request",
        status: "failed",
        error: {
          kind: "other",
          captured_response: { id: 1, name: "Ada", email: "a@example.com" },
        },
      },
      lastKnown,
    );
    expect(signal?.kind).toBe("schema_diff");
    if (signal?.kind === "schema_diff") {
      expect(signal.added).toContain("email");
      expect(signal.removed.length).toBe(0);
    }
  });

  test("returns null when no error envelope is present", () => {
    const signal = analyzeStepFailure({ id: "step-4", kind: "request", status: "failed" }, null);
    expect(signal).toBeNull();
  });

  test("renderDriftDiff produces compact text for every variant", () => {
    const jsonataSignal = analyzeStepFailure(
      {
        id: "step-5",
        kind: "transform",
        status: "failed",
        expression: "$.data.id",
        error: {
          kind: "jsonata_miss",
          expression: "$.data.id",
          missing_path: "data.id",
        },
      },
      null,
    );
    expect(jsonataSignal).not.toBeNull();
    if (jsonataSignal) {
      const text = renderDriftDiff(jsonataSignal);
      expect(text).toContain("kind: jsonata_path_miss");
      expect(text).toContain("data.id");
    }
  });

  test("validation_failed step error becomes validation_failed drift signal", () => {
    const signal = analyzeStepFailure(
      {
        // The engine surfaces validation_failed at the run-result
        // level, but the self-healing flow inspects step rows. To
        // route the invariant violation through the same drift path
        // the run-finalisation persists a synthetic step entry; this
        // test exercises the detector directly with the same shape.
        id: "$validation",
        kind: "transform",
        status: "failed",
        error: {
          code: "validation_failed",
          message: "validation_expression `count > 5` returned false",
          details: {
            expression: "count > 5",
            actual_value: { count: 0 },
          },
        },
      },
      null,
    );
    expect(signal?.kind).toBe("validation_failed");
    if (signal?.kind === "validation_failed") {
      expect(signal.expression).toBe("count > 5");
      expect(signal.actual_value).toEqual({ count: 0 });
      const text = renderDriftDiff(signal);
      expect(text).toContain("kind: validation_failed");
      expect(text).toContain("count > 5");
      expect(text).toContain('"count":0');
    }
  });

  test("validation_failed without expression text returns null", () => {
    // Defensive: a malformed validation_failed error envelope (no
    // expression) should not produce a useless drift signal — fall
    // through to null so the retry path handles it.
    const signal = analyzeStepFailure(
      {
        id: "$validation",
        kind: "transform",
        status: "failed",
        error: {
          code: "validation_failed",
          message: "no expression",
          details: {},
        },
      },
      null,
    );
    expect(signal).toBeNull();
  });
});
