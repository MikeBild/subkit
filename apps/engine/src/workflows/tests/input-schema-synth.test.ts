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

  it("collects input.input.X references inside JavaScript transforms", () => {
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
          language: "javascript",
          expression: "return { city: input.input.city, date: input.input.date };",
        },
      ],
    };
    const schema = synthesizeInputSchema(dag);
    expect(schema).not.toBeNull();
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(["city", "date"]);
  });

  it("merges placeholder + JS transform identifiers, dedup'd", () => {
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
          language: "javascript",
          expression: "return { c: input.input.city, d: input.input.date };",
        },
      ],
    };
    const schema = synthesizeInputSchema(dag);
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(["city", "date"]);
  });

  it("collects $input.X references inside a jsonata branch.when predicate", () => {
    // JSONata survives in the branch.when slot; the synthesiser still walks
    // its AST for `$input.<name>` references.
    const dag: WorkflowDef = {
      name: "branch-refs",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: "https://example.test/ping",
        },
        {
          kind: "branch",
          id: "gate",
          when: "$input.region = 'eu' and $input.tier",
          then_steps: ["fetch"],
        },
      ],
    };
    const schema = synthesizeInputSchema(dag);
    expect(schema).not.toBeNull();
    expect(Object.keys(schema?.properties ?? {}).sort()).toEqual(["region", "tier"]);
  });

  it("ignores a malformed jsonata branch.when without crashing", () => {
    const dag: WorkflowDef = {
      name: "broken",
      steps: [
        {
          kind: "branch",
          id: "gate",
          when: "this is not ( valid",
          then_steps: ["gate"],
        },
      ],
    };
    expect(() => synthesizeInputSchema(dag)).not.toThrow();
    expect(synthesizeInputSchema(dag)).toBeNull();
  });

  it("returns null for a JS transform that references no workflow input", () => {
    const dag: WorkflowDef = {
      name: "js",
      steps: [
        {
          kind: "transform",
          id: "t",
          language: "javascript",
          expression: "return { x: input.scope.fetch.data };",
        },
      ],
    };
    expect(synthesizeInputSchema(dag)).toBeNull();
  });
});
