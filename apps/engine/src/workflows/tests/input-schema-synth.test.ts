// biome-ignore-all lint/suspicious/noTemplateCurlyInString: this file tests the
// workflow placeholder syntax `${input.X}` — literal curly-brace content is
// the test fixture, not a missed template interpolation.

import { describe, expect, it } from "bun:test";
import { resolveWorkflowInputContract, synthesizeInputSchema } from "../input-schema-synth.ts";
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

describe("resolveWorkflowInputContract — precedence", () => {
  // A DAG whose only input signal is an `input_schema_sample`: the
  // structural synth would otherwise miss the `filename` key because the
  // body only interpolates `markdown` (regression this tier closes).
  const sampleOnlyDag = (): WorkflowDef =>
    ({
      name: "sample-only",
      input_schema_sample: { markdown: "# hi", filename: "slides.md", count: 3 },
      steps: [
        {
          kind: "request",
          id: "upload",
          method: "POST",
          url: "https://example.test/upload",
          body: { content: "${input.markdown}" },
        },
      ],
    }) as unknown as WorkflowDef;

  it("uses the sample-derived schema (with required) when no input_schema is declared", () => {
    const contract = resolveWorkflowInputContract(sampleOnlyDag());
    expect(contract).not.toBeNull();
    // The winning tier is reported so inspect_workflow can tell the model
    // the contract is a real sampled shape, not a structural guess.
    expect(contract?.source).toBe("sample");
    // Sample keys become properties AND required — including `filename`
    // and `count`, which the structural placeholder scan never sees.
    expect(contract?.properties.sort()).toEqual(["count", "filename", "markdown"]);
    expect(contract?.required.sort()).toEqual(["count", "filename", "markdown"]);
    // Scalar types come from the concrete sample values.
    const props = contract?.schema.properties as Record<string, { type: string } | undefined>;
    expect(props.markdown?.type).toBe("string");
    expect(props.filename?.type).toBe("string");
    expect(props.count?.type).toBe("number");
  });

  it("declared input_schema still wins over the sample", () => {
    const dag = {
      ...sampleOnlyDag(),
      input_schema: {
        type: "object",
        properties: { markdown: { type: "string" } },
        required: ["markdown"],
      },
    } as unknown as WorkflowDef;
    const contract = resolveWorkflowInputContract(dag);
    expect(contract).not.toBeNull();
    expect(contract?.source).toBe("declared");
    // Only the declared key — the sample's `filename`/`count` are ignored.
    expect(contract?.properties).toEqual(["markdown"]);
    expect(contract?.required).toEqual(["markdown"]);
  });

  it("falls through to structural synth when there is no sample and no declared schema", () => {
    const dag: WorkflowDef = {
      name: "synth-only",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: "https://example.test/${input.city}",
        },
      ],
    };
    const contract = resolveWorkflowInputContract(dag);
    expect(contract).not.toBeNull();
    expect(contract?.source).toBe("synth");
    // Structural synth: placeholder-derived property, additionalProperties true,
    // no schema-level `required` so the contract requires every property.
    expect(contract?.properties).toEqual(["city"]);
    expect(contract?.required).toEqual(["city"]);
    expect(contract?.schema.additionalProperties).toBe(true);
  });

  it("ignores a scalar/empty-object sample and falls back to structural synth", () => {
    // A non-object sample carries no named keys → not a usable contract;
    // the structural synth must still drive the result.
    const dag = {
      name: "scalar-sample",
      input_schema_sample: "just a string",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: "https://example.test/${input.city}",
        },
      ],
    } as unknown as WorkflowDef;
    const contract = resolveWorkflowInputContract(dag);
    // A scalar sample cannot win the `sample` tier — the contract falls
    // through to the structural synth.
    expect(contract?.source).toBe("synth");
    expect(contract?.properties).toEqual(["city"]);
    expect(contract?.schema.additionalProperties).toBe(true);
  });

  it("returns null when there is neither a usable sample nor any input reference", () => {
    const dag = {
      name: "empty-sample",
      input_schema_sample: {},
      steps: [{ kind: "request", id: "fetch", method: "GET", url: "https://example.test/ping" }],
    } as unknown as WorkflowDef;
    expect(resolveWorkflowInputContract(dag)).toBeNull();
  });
});
