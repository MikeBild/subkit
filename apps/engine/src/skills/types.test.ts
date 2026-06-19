// SkillSchema — capability/safety contract + activates_when discriminator.
// Pinned in unit tests so the no-backwards-compat invariant from
// migration 0006 (auto_load + trigger_keywords removed; activates_when
// added) cannot silently regress.

import { describe, expect, test } from "bun:test";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import {
  CreateSkillSchema,
  SkillActivationSchema,
  SkillIdempotencySchema,
  SkillMaturitySchema,
  SkillSchema,
  SkillSideEffectsSchema,
} from "./types.ts";

const TEST_NOW_MS = getTestNow();

describe("SkillActivationSchema — discriminated union", () => {
  test("accepts every kind", () => {
    expect(SkillActivationSchema.safeParse({ kind: "baseline" }).success).toBe(true);
    expect(SkillActivationSchema.safeParse({ kind: "tool", tool: "probe_connector" }).success).toBe(
      true,
    );
    expect(
      SkillActivationSchema.safeParse({
        kind: "tool_arg",
        tool: "propose_step",
        path: "step.kind",
        equals: "request",
      }).success,
    ).toBe(true);
    expect(
      SkillActivationSchema.safeParse({ kind: "connector_driver", driver: "postgres" }).success,
    ).toBe(true);
    expect(
      SkillActivationSchema.safeParse({ kind: "connector_template", slug: "stripe" }).success,
    ).toBe(true);
    expect(
      SkillActivationSchema.safeParse({ kind: "connector_recipe_match", template: "stripe" })
        .success,
    ).toBe(true);
    expect(
      SkillActivationSchema.safeParse({ kind: "intent_keyword", word: "stripe customers" }).success,
    ).toBe(true);
  });

  test("rejects unknown kind", () => {
    expect(SkillActivationSchema.safeParse({ kind: "made_up" }).success).toBe(false);
  });

  test("rejects empty tool / driver / slug strings", () => {
    expect(SkillActivationSchema.safeParse({ kind: "tool", tool: "" }).success).toBe(false);
    expect(SkillActivationSchema.safeParse({ kind: "connector_driver", driver: "" }).success).toBe(
      false,
    );
    expect(SkillActivationSchema.safeParse({ kind: "connector_template", slug: "" }).success).toBe(
      false,
    );
  });

  test("tool_arg accepts string, number, boolean for `equals`", () => {
    for (const equals of ["x", 1, true]) {
      expect(
        SkillActivationSchema.safeParse({
          kind: "tool_arg",
          tool: "t",
          path: "a.b",
          equals,
        }).success,
      ).toBe(true);
    }
    expect(
      SkillActivationSchema.safeParse({
        kind: "tool_arg",
        tool: "t",
        path: "a.b",
        equals: { not: "scalar" },
      }).success,
    ).toBe(false);
  });
});

describe("SkillSchema — capability/safety enums", () => {
  test("side_effects enum", () => {
    expect(SkillSideEffectsSchema.parse("read")).toBe("read");
    expect(SkillSideEffectsSchema.parse("destructive")).toBe("destructive");
    expect(SkillSideEffectsSchema.safeParse("nuke").success).toBe(false);
  });

  test("idempotency enum", () => {
    expect(SkillIdempotencySchema.parse("naturally")).toBe("naturally");
    expect(SkillIdempotencySchema.safeParse("yes").success).toBe(false);
  });

  test("maturity enum", () => {
    expect(SkillMaturitySchema.parse("experimental")).toBe("experimental");
    expect(SkillMaturitySchema.safeParse("beta").success).toBe(false);
  });
});

describe("CreateSkillSchema", () => {
  test("accepts minimal payload (defaults to read/none/stable/[])", () => {
    const parsed = CreateSkillSchema.parse({
      scope: "global",
      title: "T",
      body: "B",
    });
    expect(parsed.scope).toBe("global");
  });

  test("legacy front-matter keys are not part of the schema", () => {
    // SkillSchema replaced auto_load + trigger_keywords-as-top-level
    // inputs with `activates_when`. This guards the no-backwards-compat
    // invariant: a payload that carries one of the old keys must NOT
    // round-trip through CreateSkillSchema.parse — the unknown keys
    // are stripped silently because the Zod object is open-shaped.
    const input = {
      scope: "global" as const,
      title: "T",
      body: "B",
      auto_load: true,
      trigger_keywords: ["x"],
    };
    const withLegacy = CreateSkillSchema.parse(
      input as Parameters<typeof CreateSkillSchema.parse>[0],
    );
    expect((withLegacy as Record<string, unknown>).auto_load).toBeUndefined();
    expect((withLegacy as Record<string, unknown>).trigger_keywords).toBeUndefined();
  });
});

describe("SkillSchema — full row defaults", () => {
  test("required fields plus capability/safety defaults", () => {
    const parsed = SkillSchema.parse({
      id: "00000000-0000-0000-0000-000000000001",
      tenant_id: "tenant-a",
      scope: "global",
      connector_id: null,
      workflow_id: null,
      title: "T",
      body: "B",
      status: "active",
      source: "manual",
      version: 1,
      created_at: new Date(TEST_NOW_MS).toISOString(),
      updated_at: new Date(TEST_NOW_MS).toISOString(),
    });
    expect(parsed.activates_when).toEqual([]);
    expect(parsed.gates_tools).toEqual([]);
    expect(parsed.input_schema).toBeNull();
    expect(parsed.output_schema).toBeNull();
    expect(parsed.side_effects).toBe("read");
    expect(parsed.idempotency).toBe("none");
    expect(parsed.maturity).toBe("stable");
    expect(parsed.tags).toEqual([]);
  });
});
