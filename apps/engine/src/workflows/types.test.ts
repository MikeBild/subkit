// Schema regression: `kind: "tool"` workflow steps must be rejected
// at parse time, not silently accepted. The 4.2.0 retire removed the
// `tool` discriminator branch from `StepSchema`; a future refactor
// that re-adds the case (or accidentally widens the union) would
// re-open the docker-sandbox attack surface this PR closed.
//
// Also covers the W3a-for_each schema:
//   - `for_each` on baseStep accepts a JS selector string.
//   - `validateWorkflowDef` rejects `language: "jsonata"` transform steps
//     and `kind: "loop"` steps (both retired from authored contract).

import { describe, expect, test } from "bun:test";
import { StepSchema } from "./types.ts";
import { validateWorkflowDef } from "./validator.ts";

describe("StepSchema — retired `tool` step is rejected", () => {
  test("rejects { kind: 'tool', image: 'alpine' } with a discriminator error", () => {
    const result = StepSchema.safeParse({
      kind: "tool",
      id: "x",
      image: "alpine",
      cmd: ["echo", "hi"],
    });
    expect(result.success).toBe(false);
  });

  test("the discriminated union has exactly the supported kinds", () => {
    // Fence accidental widening: a future PR that adds a new kind
    // (or re-introduces `tool`) trips this assertion before the new
    // branch can ship without a corresponding recipe + LLM prompt
    // update.
    const options = (StepSchema as unknown as { options: ReadonlyArray<unknown> }).options;
    const kinds = options
      .map((o) => {
        const shape = (o as { shape?: { kind?: { value?: string } } }).shape;
        return shape?.kind?.value ?? null;
      })
      .filter((k): k is string => typeof k === "string")
      .sort();
    expect(kinds).toEqual([
      "branch",
      "call",
      "loop",
      "parallel",
      "request",
      "transform",
      "wait",
      "wait_for_event",
    ]);
  });

  test("propose-step's VALID_KINDS is a subset of StepSchema's discriminator", async () => {
    // The LLM authoring palette (apps/engine/src/conversations/tools/
    // propose-step.ts) deliberately exposes a SUBSET of the schema's
    // kinds — wait_for_event is omitted because the LLM can't
    // reliably author it (requires planning around external events).
    // This fence catches drift in two directions:
    //   - StepSchema LOSES a kind that propose-step still exposes →
    //     propose-step would offer the LLM a kind that doesn't parse;
    //     fence fires.
    //   - propose-step adds a kind StepSchema never had → typo or
    //     stale literal; fence fires.
    const { VALID_KINDS } = await import("../conversations/tools/propose-step.ts");
    const options = (StepSchema as unknown as { options: ReadonlyArray<unknown> }).options;
    const schemaKinds = new Set(
      options
        .map((o) => {
          const shape = (o as { shape?: { kind?: { value?: string } } }).shape;
          return shape?.kind?.value ?? null;
        })
        .filter((k): k is string => typeof k === "string"),
    );
    for (const k of VALID_KINDS) {
      expect(
        schemaKinds.has(k),
        `propose-step exposes kind="${k}" which is not in StepSchema discriminator`,
      ).toBe(true);
    }
  });

  test("the supported kinds still parse", () => {
    const baseFields = { id: "x" };
    const samples: Array<Record<string, unknown>> = [
      { ...baseFields, kind: "request", url: "https://api.example.com" },
      { ...baseFields, kind: "transform", expression: "$" },
      { ...baseFields, kind: "call", workflow_slug: "other" },
      { ...baseFields, kind: "wait", duration_ms: 1000 },
      { ...baseFields, kind: "wait_for_event", event_name: "approved", timeout_ms: 60000 },
      {
        ...baseFields,
        kind: "branch",
        when: "$.x = true",
        then_steps: ["a"],
      },
      { ...baseFields, kind: "parallel", branches: [["a"], ["b"]] },
      { ...baseFields, kind: "loop", over: "$.list", body: ["b"], item_var: "row" },
    ];
    for (const s of samples) {
      const result = StepSchema.safeParse(s);
      expect(result.success, `kind=${s.kind} should parse: ${JSON.stringify(result)}`).toBe(true);
    }
  });
});

describe("baseStep.for_each — W3a schema", () => {
  test("for_each is accepted on a request step (Zod parse)", () => {
    const result = StepSchema.safeParse({
      id: "fetch_item",
      kind: "request",
      method: "GET",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder tests the grammar.
      url: "https://api.example.com/items/${item.id}",
      for_each: "(sourceData) => sourceData.list_items.data",
    });
    expect(result.success).toBe(true);
  });

  test("for_each is accepted on a transform step (Zod parse)", () => {
    const result = StepSchema.safeParse({
      id: "shape_item",
      kind: "transform",
      language: "javascript",
      expression: "return { id: $item.id, name: $item.name };",
      for_each: "(sourceData) => sourceData.fetch_all.data.items",
    });
    expect(result.success).toBe(true);
  });

  test("for_each is optional — steps without it still parse", () => {
    const result = StepSchema.safeParse({
      id: "plain",
      kind: "transform",
      language: "javascript",
      expression: "return 1;",
    });
    expect(result.success).toBe(true);
  });

  test("for_each coexists with data_selector (output projector) on the same step", () => {
    // data_selector = JSONPath-lite output projector (applySelector in step-runner)
    // for_each      = JS selector that returns the iteration array (runJs path)
    // The two fields are distinct and must never shadow each other.
    const result = StepSchema.safeParse({
      id: "iter_and_project",
      kind: "request",
      method: "GET",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder tests the grammar.
      url: "https://api.example.com/items/${item.id}/detail",
      for_each: "(sourceData) => sourceData.fetch_projects.data",
      data_selector: "$.body.items",
    });
    expect(result.success).toBe(true);
  });
});

describe("validateWorkflowDef — E4 input_schema drift", () => {
  const BASE_REQUEST_STEP = {
    id: "fetch",
    kind: "request",
    method: "GET",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder tests the grammar.
    url: "https://api.example.com/essays/${input.essay_id}",
  };

  test("accepts workflow with no input_schema (no drift check)", () => {
    const res = validateWorkflowDef({
      name: "no-schema",
      steps: [BASE_REQUEST_STEP],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("accepts when declared properties cover all referenced keys", () => {
    const res = validateWorkflowDef({
      name: "ok",
      input_schema: {
        type: "object",
        properties: { essay_id: { type: "string" } },
      },
      steps: [BASE_REQUEST_STEP],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("rejects when step references a key absent from input_schema.properties", () => {
    const res = validateWorkflowDef({
      name: "drift",
      input_schema: {
        type: "object",
        // essay_id is used in the URL but NOT declared here
        properties: { word_count: { type: "number" } },
      },
      steps: [BASE_REQUEST_STEP],
    });
    expect(res.ok).toBe(false);
    const messages = res.errors.map((e) => e.message);
    expect(messages.some((m) => m.includes('"essay_id"') && m.includes("not declared"))).toBe(true);
  });

  test("allows a required key that no step references (wholesale $input / JS transforms)", () => {
    // The drift check only flags referenced-but-undeclared keys. The reverse
    // direction (declared required but unreferenced) is intentionally NOT an
    // error: a step may read `$input` wholesale, or a JS transform may read
    // `input.<key>` invisibly to the extractor, so flagging it false-positives
    // on legitimate workflows (e.g. journey 48 charge-processor).
    const res = validateWorkflowDef({
      name: "unused-required",
      input_schema: {
        type: "object",
        properties: {
          essay_id: { type: "string" }, // used via ${input.essay_id}
          unused_key: { type: "string" }, // declared required but not referenced → allowed
        },
        required: ["unused_key"],
      },
      steps: [BASE_REQUEST_STEP],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("non-required declared properties that are unreferenced produce no error", () => {
    const res = validateWorkflowDef({
      name: "optional-unused",
      input_schema: {
        type: "object",
        properties: {
          essay_id: { type: "string" },
          optional_extra: { type: "string" }, // not required, not referenced → ok
        },
        // no required array
      },
      steps: [BASE_REQUEST_STEP],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("works for multiple referenced keys — all must be declared", () => {
    const res = validateWorkflowDef({
      name: "multi-ref",
      input_schema: {
        type: "object",
        properties: {
          essay_id: { type: "string" },
          // author_id is missing → error
        },
      },
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder tests the grammar.
          url: "https://api.example.com/essays/${input.essay_id}/by/${input.author_id}",
        },
      ],
    });
    expect(res.ok).toBe(false);
    const messages = res.errors.map((e) => e.message);
    expect(messages.some((m) => m.includes('"author_id"') && m.includes("not declared"))).toBe(
      true,
    );
    // essay_id IS declared → should not appear as an error
    expect(messages.some((m) => m.includes('"essay_id"') && m.includes("not declared"))).toBe(
      false,
    );
  });

  test("skips drift check when input_schema has no properties key", () => {
    // Freeform input_schema (no properties map) — synthesiser cannot reason
    // about declared shape, so no drift check is possible.
    const res = validateWorkflowDef({
      name: "freeform",
      input_schema: { type: "object" },
      steps: [BASE_REQUEST_STEP],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });
});

describe("validateWorkflowDef — W3a retirement enforcement", () => {
  test("accepts language:'jsonata' transform step (backwards compat — still parses and validates)", () => {
    // `language: "jsonata"` is still accepted at the validation layer
    // for backwards compat with stored historical definitions. The
    // runtime default changed to `javascript`, but old JSONata-tagged
    // steps keep executing unchanged.
    const res = validateWorkflowDef({
      name: "jsonata-compat",
      steps: [
        {
          id: "shape",
          kind: "transform",
          language: "jsonata",
          expression: "{ 'x': 1 }",
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("accepts language:'javascript' transform step", () => {
    const res = validateWorkflowDef({
      name: "js-ok",
      steps: [
        {
          id: "shape",
          kind: "transform",
          language: "javascript",
          expression: "return 1;",
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("accepts transform step with no language (defaults to javascript)", () => {
    const res = validateWorkflowDef({
      name: "default-js",
      steps: [
        {
          id: "shape",
          kind: "transform",
          expression: "return 1;",
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("accepts kind:'loop' — still valid at the validation layer for backwards compat", () => {
    // `kind: "loop"` is not rejected at validateWorkflowDef. The loop
    // step kind is supported via the Zod schema and the execution engine.
    // `for_each` on baseStep is the NEW preferred form for inline iteration,
    // but loop steps continue to work unchanged.
    const res = validateWorkflowDef({
      name: "loop-ok",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/items",
        },
        {
          id: "iter",
          kind: "loop",
          over: "$scope.fetch.data",
          body: ["process"],
        },
        {
          id: "process",
          kind: "request",
          method: "GET",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder tests the grammar.
          url: "https://api.example.com/items/${item.id}",
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });

  test("accepts a request step with for_each and $item reference", () => {
    const res = validateWorkflowDef({
      name: "for-each-ok",
      steps: [
        {
          id: "fetch_all",
          kind: "request",
          method: "GET",
          url: "https://api.example.com/items",
        },
        {
          id: "fetch_item",
          kind: "request",
          method: "GET",
          // biome-ignore lint/suspicious/noTemplateCurlyInString: literal placeholder tests the grammar.
          url: "https://api.example.com/items/${item.id}",
          for_each: "(sourceData) => sourceData.fetch_all.data",
        },
      ],
    });
    expect(res.ok).toBe(true);
    expect(res.errors).toHaveLength(0);
  });
});
