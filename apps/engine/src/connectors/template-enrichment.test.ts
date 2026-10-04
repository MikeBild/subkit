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
  verified_at: null,
  respects_robots: false,
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

describe("enrichConnectorFromTemplate — credential_hints follow the chosen auth_type", () => {
  const oauthTemplate: ConnectorTemplate = {
    ...baseTemplate,
    auth_type: "oauth2",
    credential_hints: [
      {
        field: "client_id",
        label: "OAuth2 Client ID",
        secret: false,
        placeholder: "",
        doc_url: null,
      },
      {
        field: "client_secret",
        label: "OAuth2 Client Secret",
        secret: true,
        placeholder: "",
        doc_url: null,
      },
    ],
  };

  test("native auth_type reuses the template's curated hints", () => {
    const out = enrichConnectorFromTemplate({ auth_type: "oauth2" }, oauthTemplate);
    const hints = (out.config?.credential_hints ?? []) as Array<{ field: string }>;
    expect(hints.map((h) => h.field)).toEqual(["client_id", "client_secret"]);
  });

  test("basic auth gets username/password hints, NOT the OAuth2 defaults", () => {
    const out = enrichConnectorFromTemplate({ auth_type: "basic" }, oauthTemplate);
    const hints = (out.config?.credential_hints ?? []) as Array<{ field: string; secret: boolean }>;
    expect(hints.map((h) => h.field)).toEqual(["username", "password"]);
    expect(hints.find((h) => h.field === "password")?.secret).toBe(true);
    expect(hints.some((h) => h.field === "client_secret")).toBe(false);
  });

  test("bearer auth gets a single token hint", () => {
    const out = enrichConnectorFromTemplate({ auth_type: "bearer" }, oauthTemplate);
    const hints = (out.config?.credential_hints ?? []) as Array<{ field: string }>;
    expect(hints.map((h) => h.field)).toEqual(["token"]);
  });

  test("user-supplied credential_hints always win", () => {
    const out = enrichConnectorFromTemplate(
      { auth_type: "basic", config: { credential_hints: [{ field: "custom" }] } },
      oauthTemplate,
    );
    const hints = (out.config?.credential_hints ?? []) as Array<{ field: string }>;
    expect(hints.map((h) => h.field)).toEqual(["custom"]);
  });
});
