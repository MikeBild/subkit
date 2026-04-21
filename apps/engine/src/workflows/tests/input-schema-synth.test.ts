// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file tests the
// workflow placeholder syntax `${input.X}` — literal curly-brace content is
// the test fixture, not a missed template interpolation.

import { describe, expect, it } from "bun:test";
import { synthesizeInputSchema } from "../input-schema-synth.ts";
import type { WorkflowDef } from "../types.ts";

describe("synthesizeInputSchema", () => {
  it("returns null when no step references ${input.*} or $input.*", () => {
    const dag: WorkflowDef = {
      name: "no-inputs",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: "https://example.test/ping",
        },
      ],
    };
    expect(synthesizeInputSchema(dag)).toBeNull();
  });

  it("collects placeholder names from request step URL / path / query / headers / body", () => {
    const dag: WorkflowDef = {
      name: "placeholders",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "POST",
          url: "https://example.test/${input.tenant}/items",
          path: "/custom/${input.scope}",
          headers: { "x-actor": "${input.actor}" },
          query: { q: "${input.query}" },
          body: { city: "${input.city}", nested: { id: "${input.user_id}" } },
        },
      ],
    };
    const schema = synthesizeInputSchema(dag);
    expect(schema).not.toBeNull();
    expect(schema?.type).toBe("object");
    expect(schema?.additionalProperties).toBe(true);
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual([
      "actor",
      "city",
      "query",
      "scope",
      "tenant",
      "user_id",
    ]);
    for (const k of Object.keys(schema?.properties ?? {})) {
      expect(schema?.properties[k]).toEqual({ type: "string" });
    }
  });

  it("collects $input.X references inside jsonata transforms", () => {
    const dag: WorkflowDef = {
      name: "transform-refs",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: "https://example.test/ping",
        },
        {
          kind: "transform",
          id: "format",
          language: "jsonata",
          expression: '{ "city": $input.city, "date": $input.date }',
        },
      ],
    };
    const schema = synthesizeInputSchema(dag);
    expect(schema).not.toBeNull();
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(["city", "date"]);
  });

  it("merges placeholder + jsonata identifiers, dedup'd", () => {
    const dag: WorkflowDef = {
      name: "merged",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: "https://example.test/${input.city}",
        },
        {
          kind: "transform",
          id: "t",
          language: "jsonata",
          expression: '{ "c": $input.city, "d": $input.date }',
        },
      ],
    };
    const schema = synthesizeInputSchema(dag);
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(["city", "date"]);
  });

  it("ignores malformed jsonata expressions without crashing", () => {
    const dag: WorkflowDef = {
      name: "broken",
      steps: [
        {
          kind: "transform",
          id: "t",
          language: "jsonata",
          expression: "this is not ( valid",
        },
      ],
    };
    expect(() => synthesizeInputSchema(dag)).not.toThrow();
    expect(synthesizeInputSchema(dag)).toBeNull();
  });

  it("skips non-jsonata transforms (javascript language)", () => {
    const dag: WorkflowDef = {
      name: "js",
      steps: [
        {
          kind: "transform",
          id: "t",
          language: "javascript",
          expression: "return { x: input.whatever };",
        },
      ],
    };
    expect(synthesizeInputSchema(dag)).toBeNull();
  });
});
