// Pure-function tests for template-resolver.ts.
//
// Locks the snapshot-parse contract + the binding-fields shape every
// connector write goes through. The DB-touching loaders
// (listResolvedConnectorTemplates, getResolvedConnectorTemplate) need
// integration coverage; this file stays pure.

import { describe, expect, test } from "bun:test";
import { buildTemplateBindingFields, parseTemplateSnapshot } from "./template-resolver.ts";
import { loadBuiltinTemplates } from "./templates.ts";

const aTemplate = loadBuiltinTemplates()[0];
if (!aTemplate) throw new Error("expected at least one built-in template for test fixtures");

describe("parseTemplateSnapshot", () => {
  test("returns the typed template when the snapshot parses", () => {
    const out = parseTemplateSnapshot(aTemplate);
    expect(out).not.toBeNull();
    expect(out?.slug).toBe(aTemplate.slug);
    expect(out?.driver).toBe(aTemplate.driver);
  });

  test("returns null on null / undefined / non-object", () => {
    expect(parseTemplateSnapshot(null)).toBeNull();
    expect(parseTemplateSnapshot(undefined)).toBeNull();
    expect(parseTemplateSnapshot("a string")).toBeNull();
    expect(parseTemplateSnapshot(42)).toBeNull();
  });

  test("returns null on a partially-shaped object (does not throw)", () => {
    expect(parseTemplateSnapshot({ slug: "x", name: "y" })).toBeNull();
    expect(parseTemplateSnapshot({ ...aTemplate, slug: 42 })).toBeNull();
  });

  test("ignores extra fields on the input (forward-compat)", () => {
    const out = parseTemplateSnapshot({
      ...aTemplate,
      _extra_unknown_field: "future-feature",
    });
    expect(out?.slug).toBe(aTemplate.slug);
  });
});

describe("buildTemplateBindingFields", () => {
  test("flat-projects the template into the FK shape every connector write uses", () => {
    const fields = buildTemplateBindingFields({
      id: null,
      source: "builtin",
      template: aTemplate,
    });
    expect(fields.template_slug).toBe(aTemplate.slug);
    expect(fields.template_name).toBe(aTemplate.name);
    expect(fields.template_source).toBe("builtin");
    expect(fields.template_version).toBe(aTemplate.version);
    // The snapshot is the raw template object — round-trippable through
    // parseTemplateSnapshot.
    expect(parseTemplateSnapshot(fields.template_snapshot)?.slug).toBe(aTemplate.slug);
  });

  test("preserves source='tenant' when the resolved template came from a tenant override", () => {
    const fields = buildTemplateBindingFields({
      id: "00000000-0000-0000-0000-000000000001",
      source: "tenant",
      template: aTemplate,
    });
    expect(fields.template_source).toBe("tenant");
  });
});
