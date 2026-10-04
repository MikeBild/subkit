import { describe, expect, test } from "bun:test";
import { isAcceptable, verifyWorkflow } from "../verifier.ts";

describe("verifyWorkflow — JSONata parsing", () => {
  test("invalid data_selector → jsonata_syntax_error on data_selector path", () => {
    const r = verifyWorkflow({
      steps: [{ id: "r", kind: "request", method: "GET", path: "/x", data_selector: "$xxx[" }],
    });
    expect(r.errors.some((e) => e.code === "jsonata_syntax_error")).toBe(true);
    expect(r.errors.find((e) => e.code === "jsonata_syntax_error")!.path).toBe(
      "steps[0].data_selector",
    );
  });

  test("invalid branch.when → jsonata_syntax_error", () => {
    const r = verifyWorkflow({
      steps: [{ id: "b", kind: "branch", when: "a > " }],
    });
    expect(r.errors[0]!.code).toBe("jsonata_syntax_error");
  });

  test("bare JSONata function in branch.when → actionable validation error", () => {
    const r = verifyWorkflow({
      steps: [{ id: "b", kind: "branch", when: "not(true)", then_steps: [] }],
    });
    expect(r.errors).toContainEqual({
      severity: "error",
      code: "jsonata_unbound_function",
      message: "JSONata function `not(...)` is not bound; use `$not(...)`",
      path: "steps[0].when",
    });
  });

  test("$-prefixed JSONata functions remain valid", () => {
    const r = verifyWorkflow({
      steps: [{ id: "b", kind: "branch", when: "$not($boolean(false))", then_steps: [] }],
    });
    expect(r.errors).toEqual([]);
  });
});

describe("verifyWorkflow — JavaScript transforms (language-aware)", () => {
  test("valid JavaScript body → no error, NOT parsed as JSONata", () => {
    const r = verifyWorkflow({
      steps: [
        { id: "fetch", kind: "request", method: "GET", path: "/x" },
        {
          id: "t",
          kind: "transform",
          language: "javascript",
          expression:
            "const xs = input.scope.fetch.data || []; return xs.map((x) => ({ id: x.id }));",
        },
      ],
    });
    expect(r.errors).toEqual([]);
  });

  test("invalid JavaScript body → js_syntax_error (not jsonata_syntax_error)", () => {
    const r = verifyWorkflow({
      steps: [{ id: "t", kind: "transform", language: "javascript", expression: "const = ;" }],
    });
    expect(r.errors.length).toBe(1);
    expect(r.errors[0]!.code).toBe("js_syntax_error");
    expect(r.errors[0]!.path).toBe("steps[0].expression");
  });

  test("unset language defaults to JavaScript (mirrors the runtime executor)", () => {
    const r = verifyWorkflow({
      steps: [{ id: "t", kind: "transform", expression: "{ 'a': $scope.x.data }" }],
    });
    expect(r.errors.some((e) => e.code === "js_syntax_error")).toBe(true);
    expect(r.errors.some((e) => e.code === "jsonata_syntax_error")).toBe(false);
  });

  test("a correct JS body that LOOKS like the authoring session does not loop", () => {
    const r = verifyWorkflow({
      steps: [
        { id: "fetch_message", kind: "request", method: "GET", path: "/m" },
        {
          id: "extract",
          kind: "transform",
          language: "javascript",
          expression:
            "const msgs = input.scope.fetch_message.data || []; return msgs.flatMap((m) => (m.payload?.parts || []).filter((p) => p.body?.attachmentId));",
        },
      ],
    });
    expect(r.errors.filter((e) => e.code === "jsonata_syntax_error")).toEqual([]);
    expect(r.errors.filter((e) => e.code === "js_syntax_error")).toEqual([]);
  });

  test("web-scraper languages carry no expression and are skipped", () => {
    const r = verifyWorkflow({
      steps: [
        { id: "fetch", kind: "request", method: "GET", path: "/page" },
        { id: "rd", kind: "transform", language: "readability" },
      ],
    });
    expect(r.errors.filter((e) => e.code === "jsonata_syntax_error")).toEqual([]);
    expect(r.errors.filter((e) => e.code === "js_syntax_error")).toEqual([]);
  });
});

describe("verifyWorkflow — scope reference integrity", () => {
  test("reference to earlier step id is allowed", () => {
    const r = verifyWorkflow({
      steps: [
        { id: "fetch", kind: "request", method: "GET", path: "/x" },
        {
          id: "use",
          kind: "transform",
          language: "javascript",
          expression: "$scope.fetch.data",
        },
      ],
    });
    expect(r.errors).toEqual([]);
  });

  test("reference to unknown step id → scope_ref_unresolved", () => {
    const r = verifyWorkflow({
      steps: [
        {
          id: "only",
          kind: "transform",
          language: "javascript",
          expression: "$scope.not_here.data",
        },
      ],
    });
    expect(r.errors.some((e) => e.code === "scope_ref_unresolved")).toBe(true);
  });

  test("forward reference (step referring to a later step) fails", () => {
    const r = verifyWorkflow({
      steps: [
        {
          id: "a",
          kind: "transform",
          language: "javascript",
          expression: "$scope.b.data.x",
        },
        { id: "b", kind: "request", method: "GET", path: "/x" },
      ],
    });
    expect(r.errors.some((e) => e.code === "scope_ref_unresolved")).toBe(true);
  });

  test("output_transform reference resolves against all seen step ids", () => {
    const r = verifyWorkflow({
      steps: [{ id: "last", kind: "request", method: "GET", path: "/x" }],
      output_transform: "$scope.last.data",
    });
    expect(r.errors.filter((e) => e.code === "scope_ref_unresolved")).toEqual([]);
  });

  test("output_transform reference to missing step is an error", () => {
    const r = verifyWorkflow({
      steps: [{ id: "only", kind: "request", method: "GET", path: "/x" }],
      output_transform: "$scope.missing.data",
    });
    expect(r.errors.some((e) => e.code === "scope_ref_unresolved")).toBe(true);
  });

  test(`\${scope.<step>.*} form is detected the same as $scope.<step>`, () => {
    const r = verifyWorkflow({
      steps: [
        {
          id: "t",
          kind: "request",
          method: "GET",
          path: "/x",
          headers: { "x-trace": `\${scope.absent.data.id}` },
        },
      ],
    });
    expect(r.errors.some((e) => e.code === "scope_ref_unresolved")).toBe(true);
  });

  test("missing .data on a scope envelope path → scope_envelope_field_missing", () => {
    const r = verifyWorkflow({
      steps: [
        { id: "fetch", kind: "request", method: "GET", path: "/x" },
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression: "$scope.fetch.users",
        },
      ],
    });
    expect(r.errors.some((e) => e.code === "scope_envelope_field_missing")).toBe(true);
  });

  test("envelope metadata fields stay valid without .data", () => {
    const r = verifyWorkflow({
      steps: [
        { id: "fetch", kind: "request", method: "GET", path: "/x" },
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression: "return { status: $scope.fetch.status_code, headers: $scope.fetch.headers };",
        },
      ],
    });
    expect(r.errors.filter((e) => e.code === "scope_envelope_field_missing")).toEqual([]);
  });
});

describe("verifyWorkflow — method safety + idempotency hints", () => {
  test("POST without onError.mode → warning", () => {
    const r = verifyWorkflow({
      steps: [{ id: "p", kind: "request", method: "POST", path: "/x" }],
    });
    expect(r.warnings.some((w) => w.code === "write_verb_no_onerror")).toBe(true);
    expect(r.errors).toEqual([]);
  });

  test("POST WITH onError.mode → no warning", () => {
    const r = verifyWorkflow({
      steps: [
        {
          id: "p",
          kind: "request",
          method: "POST",
          path: "/x",
          onError: { mode: "retry", max_retries: 3 },
        },
      ],
    });
    expect(r.warnings.filter((w) => w.code === "write_verb_no_onerror")).toEqual([]);
  });

  test("GET with retry without idempotency_key → info", () => {
    const r = verifyWorkflow({
      steps: [
        {
          id: "g",
          kind: "request",
          method: "GET",
          path: "/x",
          onError: { mode: "retry" },
        },
      ],
    });
    expect(r.infos.some((i) => i.code === "retry_without_idempotency_key")).toBe(true);
  });
});

describe("verifyWorkflow — output_schema", () => {
  test("well-formed object schema passes", () => {
    const r = verifyWorkflow({
      steps: [{ id: "x", kind: "request", method: "GET", path: "/x" }],
      output_schema: { type: "object", properties: { id: { type: "string" } } },
    });
    expect(r.errors).toEqual([]);
    expect(r.warnings.filter((w) => w.code === "output_schema_suspicious")).toEqual([]);
  });

  test("non-object schema → error", () => {
    const r = verifyWorkflow({
      steps: [{ id: "x", kind: "request", method: "GET", path: "/x" }],
      output_schema: "not-a-schema" as unknown,
    });
    expect(r.errors.some((e) => e.code === "output_schema_not_object")).toBe(true);
  });

  test("object lacking any schema keyword → warning", () => {
    const r = verifyWorkflow({
      steps: [{ id: "x", kind: "request", method: "GET", path: "/x" }],
      output_schema: { garbage: true },
    });
    expect(r.warnings.some((w) => w.code === "output_schema_suspicious")).toBe(true);
  });
});

describe("isAcceptable", () => {
  test("true when no errors, even with warnings + infos", () => {
    const r = verifyWorkflow({
      steps: [{ id: "p", kind: "request", method: "POST", path: "/x" }],
    });
    expect(r.errors.length).toBe(0);
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(isAcceptable(r)).toBe(true);
  });

  test("false when any error is present", () => {
    const r = verifyWorkflow({
      steps: [{ id: "t", kind: "transform", expression: "bad[" }],
    });
    expect(isAcceptable(r)).toBe(false);
  });
});
