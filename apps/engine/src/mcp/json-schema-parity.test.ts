// Parity test: SDK helper output vs. the frozen Anthropic-palette contract.
//
// The WS2 migration replaced `(z as any).toJSONSchema` with the SDK's typed
// `toJsonSchemaCompat` behind `zodToJsonSchema7`. The SDK helper diverges from
// the prior native exporter in three ways unless corrected:
//
//   1. Default `io:'input'` drops `additionalProperties:false` on plain objects
//      and omits defaulted fields from `required`.
//   2. Emits a top-level `$schema` dialect marker the native exporter never produced.
//   3. Record types get a `propertyNames` node the native exporter collapsed into
//      a bare `additionalProperties`.
//
// `json-schema.ts` closes all three at the single boundary helper. These tests
// pin the closure so a future SDK upgrade that reopens any of them fails here
// before reaching the Anthropic API.
//
// Three representative tools are diffed:
//
//   cannot_help     — simple flat object (all fields typed, `required` is a subset)
//   find_workflow   — object with a defaulted field (`limit` with `.default(15)`)
//   propose_step    — object whose `step` property is a z.record(z.unknown())
//                     (the record type that previously emitted `propertyNames`)
//
// `edit_workflow_patch` is exercised structurally (not pinned byte-for-byte) to
// confirm `oneOf` discriminated unions survive the helper without gaining `$ref`
// or losing inner `additionalProperties:false`.

import { describe, expect, it } from "bun:test";
import type { ZodType } from "zod";
import { getTool, listTools } from "../conversations/tools/index.ts";
import { zodToJsonSchema7 } from "./json-schema.ts";

function schema(toolName: string): Record<string, unknown> {
  const tool = getTool(toolName);
  if (!tool) throw new Error(`tool not registered: ${toolName}`);
  return zodToJsonSchema7(tool.inputSchema as ZodType);
}

// ---------------------------------------------------------------------------
// Global invariants — hold for every tool in the palette
// ---------------------------------------------------------------------------

describe("sdk helper — global palette invariants", () => {
  const tools = listTools();

  it("no tool emits a top-level $schema dialect marker (WS2 fix #2)", () => {
    for (const t of tools) {
      const s = zodToJsonSchema7(t.inputSchema as ZodType);
      if ("$schema" in s) {
        throw new Error(`tool ${t.name} emitted a $schema key — normalizeToNativeShape missed it`);
      }
    }
  });

  it("every tool root has additionalProperties:false (WS2 fix #1 — pipeStrategy:output)", () => {
    for (const t of tools) {
      const s = zodToJsonSchema7(t.inputSchema as ZodType);
      if (s.additionalProperties !== false) {
        throw new Error(
          `tool ${t.name} root additionalProperties=${JSON.stringify(s.additionalProperties)} — expected false`,
        );
      }
    }
  });

  it("no tool emits $ref / $defs / definitions at the root (Anthropic does not deref)", () => {
    for (const t of tools) {
      const s = zodToJsonSchema7(t.inputSchema as ZodType);
      if ("$ref" in s) throw new Error(`tool ${t.name} root has $ref`);
      if ("$defs" in s) throw new Error(`tool ${t.name} root has $defs`);
      if ("definitions" in s) throw new Error(`tool ${t.name} root has definitions`);
    }
  });

  it("every tool root type is 'object'", () => {
    for (const t of tools) {
      const s = zodToJsonSchema7(t.inputSchema as ZodType);
      if (s.type !== "object") {
        throw new Error(`tool ${t.name} root type=${JSON.stringify(s.type)} — expected 'object'`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// cannot_help — flat object parity
// ---------------------------------------------------------------------------

describe("sdk helper parity — cannot_help (flat object)", () => {
  it("emits the expected frozen shape", () => {
    const s = schema("cannot_help");

    // Root: type:object, additionalProperties:false, required:[reason]
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(["reason"]);

    // No dialect marker or $ref family
    expect(s.$schema).toBeUndefined();
    expect(s.$ref).toBeUndefined();
    expect(s.$defs).toBeUndefined();

    // Properties: reason (required), missing_capability + suggest_alternative (optional)
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(typeof props).toBe("object");
    expect(props.reason?.type).toBe("string");
    expect(props.missing_capability?.type).toBe("string");
    expect(props.suggest_alternative?.type).toBe("string");

    // Optional fields absent from required
    const req = s.required as string[];
    expect(req).not.toContain("missing_capability");
    expect(req).not.toContain("suggest_alternative");
  });
});

// ---------------------------------------------------------------------------
// find_workflow — defaulted field parity (pipeStrategy:output regression gate)
//
// `io:'input'` (SDK default) omits defaulted fields from `required`. With
// `pipeStrategy:'output'` the `limit` field carries `.default(15)` and MUST
// still appear in `required` (it is not optional from the model's perspective).
// ---------------------------------------------------------------------------

describe("sdk helper parity — find_workflow (defaulted field in required)", () => {
  it("limit with .default(15) is still present in required (pipeStrategy:output)", () => {
    const s = schema("find_workflow");

    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);

    // `limit` has a Zod default — under io:'input' it would be omitted from
    // required; under io:'output' (which pipeStrategy:'output' restores) it
    // appears because the model must always supply a value for it.
    expect(s.required).toContain("limit");

    // Sanity: optional fields without a default are NOT in required.
    const req = s.required as string[];
    expect(req).not.toContain("query");
    expect(req).not.toContain("id");

    // The limit property itself has type:integer with min/max constraints.
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.limit?.type).toBe("integer");
    expect(typeof props.limit?.minimum).toBe("number");
    expect(typeof props.limit?.maximum).toBe("number");
  });
});

// ---------------------------------------------------------------------------
// propose_step — z.record(z.unknown()) parity (no propertyNames node)
//
// The SDK helper (via zod/v4-mini) annotates record key schemas as
// `propertyNames`. The native exporter collapsed records to a bare
// `additionalProperties`. `normalizeToNativeShape` strips `propertyNames`
// from any object node that also has `additionalProperties` so the shape
// is byte-identical to what shipped before.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// run_workflow — `$input` map parity (pipeStrategy:output regression gate)
//
// The workflow's `$input` map is a `z.union([z.record(...), z.string()])
// .transform(...).pipe(z.record(...))` slot (see
// `conversations/tools/generated/writes/run-workflow.ts`) so a client sees a
// typed OBJECT rather than the empty `{}` schema a bare `z.unknown()` would
// emit — the empty schema tells a client nothing and invites it to
// serialize the input map into a string. `environment` carries
// `.default("dev")`; under `pipeStrategy:'output'` a defaulted field still
// appears in `required` because the model must always supply a value for
// it. Do NOT "fix" that by dropping it from required — the contract is
// designed, not a bug.
// ---------------------------------------------------------------------------

describe("sdk helper parity — run_workflow (input map + inherited environment)", () => {
  it("input is no longer the empty schema `{}`", () => {
    const s = schema("run_workflow");
    const props = s.properties as Record<string, Record<string, unknown>>;
    const input = props.input;
    expect(input).toBeDefined();
    expect(Object.keys(input ?? {}).length).toBeGreaterThan(0);
    // Never the bare empty-object escape hatch a `z.unknown()` would emit.
    expect(input).not.toEqual({});
  });

  it("environment stays optional so the saved schedule selects the runtime environment", () => {
    const s = schema("run_workflow");
    expect(s.required ?? []).not.toContain("environment");
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.environment?.enum).toEqual(["dev", "prod"]);
    expect(props.environment?.default).toBeUndefined();
  });

  it("root seals with additionalProperties:false and no $ref/$defs", () => {
    const s = schema("run_workflow");
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    expect(s.$ref).toBeUndefined();
    expect(s.$defs).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// edit_workflow_patch — discriminated union structural check
//
// Confirms that a complex discriminated union (RFC 6902 patch ops) survives
// the helper without gaining root-level $ref / $defs or losing inner
// `additionalProperties:false` on the oneOf branches.
// ---------------------------------------------------------------------------

describe("sdk helper parity — edit_workflow_patch (discriminated union)", () => {
  it("root is type:object, patches is type:array", () => {
    const s = schema("edit_workflow_patch");
    expect(s.type).toBe("object");
    expect(s.additionalProperties).toBe(false);
    const props = s.properties as Record<string, Record<string, unknown>>;
    expect(props.patches?.type).toBe("array");
  });

  it("no $ref / $defs in the discriminated union output", () => {
    const s = schema("edit_workflow_patch");
    expect(s.$ref).toBeUndefined();
    expect(s.$defs).toBeUndefined();
    expect(s.definitions).toBeUndefined();
  });

  it("every oneOf branch inside patches.items seals with additionalProperties:false", () => {
    const s = schema("edit_workflow_patch");
    const props = s.properties as Record<string, { items?: { oneOf?: unknown[] } }>;
    const branches = props.patches?.items?.oneOf;
    // The discriminated union must produce branches (oneOf array).
    expect(Array.isArray(branches)).toBe(true);
    expect((branches as unknown[]).length).toBeGreaterThan(0);
    // Walk every branch — each is an object schema and must be sealed.
    for (const branch of branches as Record<string, unknown>[]) {
      expect(branch.type).toBe("object");
      expect(branch.additionalProperties).toBe(false);
    }
  });
});
