// Settings registry — invariants the wider system depends on.
//
// Coverage targets:
//   - every spec parses its own default through its own schema
//   - keys are unique across the registry
//   - secret-tagged specs always have non-empty descriptions (so the
//     `sk settings configure` wizard never asks a secret without
//     telling the operator what it is)
//   - listSpecs() and specsByCategory() agree on the universe

import { describe, expect, test } from "bun:test";
import { getSpec, listSpecs, maskValue, SETTING_SPECS, specsByCategory } from "./registry.ts";

describe("settings registry", () => {
  test("every spec's default parses through its own schema", () => {
    for (const spec of SETTING_SPECS) {
      const parsed = spec.schema.safeParse(spec.default);
      expect(parsed.success).toBe(true);
    }
  });

  test("keys are globally unique", () => {
    const keys = SETTING_SPECS.map((s) => s.key);
    const unique = new Set(keys);
    expect(unique.size).toBe(keys.length);
  });

  test("secret-tagged specs carry a non-empty description", () => {
    for (const spec of SETTING_SPECS.filter((s) => s.secret)) {
      expect(spec.description.length).toBeGreaterThan(0);
    }
  });

  test("getSpec returns the spec for a known key, undefined otherwise", () => {
    expect(getSpec("llm.provider")?.key).toBe("llm.provider");
    expect(getSpec("does.not.exist")).toBeUndefined();
  });

  test("specsByCategory groups every spec exactly once", () => {
    const grouped = specsByCategory();
    const flat = Object.values(grouped).flat();
    expect(flat.length).toBe(SETTING_SPECS.length);
    const keysInBuckets = new Set(flat.map((s) => s.key));
    expect(keysInBuckets.size).toBe(SETTING_SPECS.length);
  });

  test("listSpecs returns a fresh copy each call (no shared mutation)", () => {
    const a = listSpecs();
    const b = listSpecs();
    expect(a).not.toBe(b);
    expect(a.length).toBe(b.length);
  });
});

describe("maskValue", () => {
  const secretSpec = SETTING_SPECS.find((s) => s.secret);
  const plainSpec = SETTING_SPECS.find((s) => !s.secret);

  test("masks non-empty secrets", () => {
    if (!secretSpec) throw new Error("registry has no secret spec");
    expect(maskValue(secretSpec, "sk-real-token")).toBe("***");
  });

  test("leaves unset secrets visible (so callers can distinguish set vs unset)", () => {
    if (!secretSpec) throw new Error("registry has no secret spec");
    expect(maskValue(secretSpec, "")).toBe("");
    expect(maskValue(secretSpec, null)).toBeNull();
    expect(maskValue(secretSpec, undefined)).toBeUndefined();
  });

  test("passes plain values through untouched", () => {
    if (!plainSpec) throw new Error("registry has no plain spec");
    expect(maskValue(plainSpec, "anthropic")).toBe("anthropic");
    expect(maskValue(plainSpec, 42)).toBe(42);
  });
});
