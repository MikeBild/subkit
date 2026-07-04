// resolveConnectorOAuthConfigDetailed — typed incomplete-config reasons.
//
// Pre-fix every incomplete OAuth config collapsed into `null` and the
// oauth/start route threw one generic "missing oauth2 config
// (issuer_url + client_id)" — undiagnosable from the CLI when the real
// cause was "the template expects tenant OAuth client credentials and
// none were ever stored" (the by-far most common case: a template-bound
// connector before `sk connector-templates set-oauth`).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import {
  resolveConnectorOAuthConfig,
  resolveConnectorOAuthConfigDetailed,
} from "./template-binding.ts";
import { upsertTemplateOAuthCredentials } from "./template-credentials.ts";

let testDb: TestDb;
let tenantId: string;

beforeAll(async () => {
  testDb = await createTestDb("oauth_resolution");
  const [t] = await testDb.db
    .insert(tenants)
    .values({ slug: "oauth-res-t", display_name: "oauth res tenant" })
    .returning();
  tenantId = t!.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

const TEMPLATE_SLUG = "acme-oauth-template";

function snapshotOauth(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    slug: TEMPLATE_SLUG,
    name: "Acme OAuth",
    driver: "http",
    base_url: "https://acme.test",
    auth_type: "oauth2",
    ingestion_source: "openapi",
    ingestion_url: "https://acme.test/openapi.json",
    icon: "acme.svg",
    description: "Test template",
    category: "productivity",
    tags: [],
    aliases: [],
    setup_instructions: "none",
    auth_options: [],
    url_pattern: null,
    keywords: [],
    inline_schema: null,
    probe_endpoint: null,
    credential_hints: [],
    base_url_options: [],
    pagination_defaults: null,
    capabilities: { webhooks: false, webhook_events: [], rate_limits: null },
    recipes: [],
    verified_at: null,
    operator_quirks: {},
    default_skill: null,
    example_paths: [],
    oauth: {
      issuer_url: "https://idp.acme.test",
      authorization_endpoint: "https://idp.acme.test/authorize",
      token_endpoint: "https://idp.acme.test/token",
      scopes: "openid",
      grant_type: "authorization_code",
      token_auth_method: "body",
      token_content_type: "form",
      use_pkce: true,
      client_id: null,
      extra_headers: {},
      dynamic_registration: false,
      ...overrides,
    },
  };
}

function connectorLike(p: {
  template_slug?: string | null;
  template_snapshot?: Record<string, unknown> | null;
  config?: Record<string, unknown> | null;
}) {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    config: p.config ?? {},
    environment: "dev" as const,
    template_slug: p.template_slug ?? null,
    template_snapshot: p.template_snapshot ?? null,
  };
}

describe("resolveConnectorOAuthConfigDetailed", () => {
  test("template with OAuth block but no stored tenant credentials → template_oauth_credentials", async () => {
    const res = await resolveConnectorOAuthConfigDetailed(
      testDb.db,
      tenantId,
      connectorLike({ template_slug: TEMPLATE_SLUG, template_snapshot: snapshotOauth() }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.missing).toBe("template_oauth_credentials");
    // The presence-only projection stays null-shaped for capability callers.
    expect(
      await resolveConnectorOAuthConfig(
        testDb.db,
        tenantId,
        connectorLike({ template_slug: TEMPLATE_SLUG, template_snapshot: snapshotOauth() }),
      ),
    ).toBeNull();
  });

  test("no issuer_url anywhere → issuer_url", async () => {
    const res = await resolveConnectorOAuthConfigDetailed(
      testDb.db,
      tenantId,
      connectorLike({ config: { oauth: { client_id: "abc" } } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.missing).toBe("issuer_url");
  });

  test("issuer_url present but no client_id and no template context → client_id", async () => {
    const res = await resolveConnectorOAuthConfigDetailed(
      testDb.db,
      tenantId,
      connectorLike({ config: { oauth: { issuer_url: "https://idp.acme.test" } } }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.missing).toBe("client_id");
  });

  test("stored template credentials complete the config → ok", async () => {
    await upsertTemplateOAuthCredentials(
      {
        tenant_id: tenantId,
        template_slug: TEMPLATE_SLUG,
        value: { client_id: "tenant-client-id", client_secret: "tenant-secret" },
        actor_id: null,
      },
      testDb.db,
    );
    const res = await resolveConnectorOAuthConfigDetailed(
      testDb.db,
      tenantId,
      connectorLike({ template_slug: TEMPLATE_SLUG, template_snapshot: snapshotOauth() }),
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.config.client_id).toBe("tenant-client-id");
      expect(res.config.issuer_url).toBe("https://idp.acme.test");
    }
  });
});
