import { describe, expect, test } from "bun:test";
import { UNDESCRIBED_METADATA } from "../api/catalog-metadata.ts";
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

  test("ConnectorSchema.parse accepts a serialised connector that carries a template_snapshot", async () => {
    const { ConnectorSchema, serialize } = await import("../http/routes/connectors/schemas.ts");
    const fields = buildTemplateBindingFields({
      id: null,
      source: "builtin",
      template: aTemplate,
    });
    const view: Parameters<typeof serialize>[0] = {
      id: "00000000-0000-0000-0000-000000000099",
      tenant_id: "00000000-0000-0000-0000-000000000098",
      slug: "test-conn",
      display_name: "Test Connector",
      ...UNDESCRIBED_METADATA,
      driver: aTemplate.driver,
      environment: "dev",
      auth_type: "bearer",
      base_url: aTemplate.base_url,
      dsn: null,
      config: {},
      operator_quirks: {},
      template_slug: fields.template_slug,
      template_name: fields.template_name,
      template_source: fields.template_source,
      template_version: fields.template_version,
      template_snapshot: fields.template_snapshot,
      created_at: new Date(0),
      updated_at: new Date(0),
      enabled: true,
      last_error: null,
      circuit_state: "closed",
      circuit_opened_at: null,
      circuit_failure_count: 0,
      circuit_threshold: 5,
      circuit_reset_ms: 60_000,
      needs_reauth: false,
      auth_failed_at: null,
      auth_failed_reason: null,
      health_state: "ok",
      health_reason: null,
      health_error_code: null,
      sunset_at: null,
      successor_uri: null,
      self_description: {},
    };
    const serialized = serialize(view);
    const parsed = ConnectorSchema.safeParse(serialized);
    if (!parsed.success) {
      throw new Error(
        `ConnectorSchema rejected the serialised connector — public route contract drift:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
      );
    }
    expect(parsed.data.template_slug).toBe(aTemplate.slug);
    expect(parsed.data.template_snapshot).not.toBeNull();
  });
});
