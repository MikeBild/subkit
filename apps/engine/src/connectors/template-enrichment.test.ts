// Template-enrichment — propagation of operator_quirks from template
// to connector draft. Pinned in unit tests so the per-category merge
// (user wins / template fills) cannot regress.

import { describe, expect, test } from "bun:test";
import { enrichConnectorFromTemplate } from "./template-enrichment.ts";
import type { ConnectorTemplate } from "./templates.ts";

const baseTemplate: ConnectorTemplate = {
  version: 1,
  slug: "fixture",
  name: "Fixture",
  driver: "http",
  base_url: "https://api.example.com",
  auth_type: "bearer",
  oauth: null,
  default_skill: null,
  ingestion_source: null,
  ingestion_url: null,
  icon: "default",
  description: "test fixture",
  category: "test",
  tags: [],
  aliases: [],
  setup_instructions: "n/a",
  auth_options: [],
  url_pattern: null,
  keywords: [],
  inline_schema: null,
  probe_endpoint: null,
  credential_hints: [],
  base_url_options: [],
  pagination_defaults: null,
  capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
  example_paths: [],
  operator_quirks: { error_handling: "template default error note" },
  recipes: [],
  aws_service: null,
  aws_region: null,
};

describe("enrichConnectorFromTemplate — operator_quirks propagation", () => {
  test("template default fills empty draft", () => {
    const out = enrichConnectorFromTemplate({}, baseTemplate);
    expect(out.operator_quirks?.error_handling).toBe("template default error note");
  });

  test("user-supplied quirk wins per category", () => {
    const out = enrichConnectorFromTemplate(
      { operator_quirks: { error_handling: "user override" } },
      baseTemplate,
    );
    expect(out.operator_quirks?.error_handling).toBe("user override");
  });

  test("user-supplied quirks merge with template defaults across categories", () => {
    const out = enrichConnectorFromTemplate(
      { operator_quirks: { auth: "user auth note" } },
      baseTemplate,
    );
    expect(out.operator_quirks?.auth).toBe("user auth note");
    expect(out.operator_quirks?.error_handling).toBe("template default error note");
  });

  test("template with no quirks + no user quirks → operator_quirks omitted", () => {
    const stripped: ConnectorTemplate = { ...baseTemplate, operator_quirks: {} };
    const out = enrichConnectorFromTemplate({}, stripped);
    expect(out.operator_quirks).toBeUndefined();
  });
});
