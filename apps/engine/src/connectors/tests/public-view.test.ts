// The public connector projection and its way back in.
//
// Two claims, and each fails in a different direction. The projection must
// hide every secret a connector carries WITHOUT rewriting the config around
// it — an endpoint, a scope or a header name that came back masked would be a
// config the author can no longer read. And the mask must be a safe thing to
// send back: a read-modify-write that stored the mask in place of the secret
// would break the connector the moment its token expired.

import { describe, expect, test } from "bun:test";
import { UnprocessableEntityError } from "../../http/errors.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { authorityConnectorDigest } from "../../workflows/authority-configuration.ts";
import {
  CONNECTOR_SECRET_MASK,
  restoreMaskedConnectorSecrets,
  toPublicConnector,
} from "../public-view.ts";
import type { ConnectorView } from "../types.ts";

// Fixture markers, not credentials. Each is unique so a leak names its source.
const CLIENT_SECRET = "fixture-client-secret-not-real";
const HEADER_SECRET = "fixture-header-secret-not-real";
const QUERY_SECRET = "fixture-query-secret-not-real";
const BODY_SECRET = "fixture-body-secret-not-real";
const DSN_SECRET = "fixture-dsn-secret-not-real";

function view(overrides: Partial<ConnectorView> = {}): ConnectorView {
  const at = new Date(FROZEN_NOW);
  return {
    id: "00000000-0000-4000-8000-000000000001",
    tenant_id: "00000000-0000-4000-8000-000000000002",
    slug: "acme",
    display_name: "Acme",
    driver: "http",
    environment: "prod",
    auth_type: "oauth2",
    base_url: "https://api.acme.test/v2",
    dsn: null,
    config: {},
    operator_quirks: {},
    template_slug: null,
    template_name: null,
    template_source: null,
    template_version: null,
    template_snapshot: null,
    self_description: {},
    created_at: at,
    updated_at: at,
    enabled: true,
    last_error: null,
    circuit_state: "closed",
    circuit_opened_at: null,
    circuit_failure_count: 0,
    circuit_threshold: 5,
    circuit_reset_ms: 300000,
    needs_reauth: false,
    auth_failed_at: null,
    auth_failed_reason: null,
    health_state: "ok",
    health_reason: null,
    health_error_code: null,
    sunset_at: null,
    successor_uri: null,
    ...overrides,
  };
}

const NON_SECRET_OAUTH = {
  issuer_url: "https://login.acme.test",
  authorization_endpoint: "https://login.acme.test/authorize",
  token_endpoint: "https://login.acme.test/token",
  scope: "read:things write:things",
  grant_type: "authorization_code",
  token_auth_method: "body",
  token_content_type: "form",
  token_response_format: "json",
  token_response_ttl_ms: 3_600_000,
  use_pkce: true,
  client_id: "acme-client-id",
};

const CREDENTIAL_HINTS = [
  { field: "client_secret", label: "Client secret", placeholder: "", doc_url: null, secret: true },
  { field: "api_key", label: "API key", placeholder: "sk_…", doc_url: null, secret: true },
];

function secretBearingConfig(): Record<string, unknown> {
  return {
    timeout_ms: 5000,
    static_headers: {
      Accept: "application/json",
      "X-Api-Version": "2024-01",
      Authorization: `Bearer ${HEADER_SECRET}`,
      "X-Api-Key": HEADER_SECRET,
    },
    static_query: { format: "json", key: QUERY_SECRET },
    credential_hints: CREDENTIAL_HINTS,
    oauth: {
      ...NON_SECRET_OAUTH,
      client_secret: CLIENT_SECRET,
      extra_token_headers: { "X-Tenant": "acme", Authorization: `Basic ${HEADER_SECRET}` },
      token_request_body_mapping: { client_id: "acme-client-id", client_secret: BODY_SECRET },
    },
  };
}

describe("toPublicConnector — what is hidden", () => {
  test("no secret carried in config survives into the projection", () => {
    const out = JSON.stringify(toPublicConnector(view({ config: secretBearingConfig() })));
    for (const secret of [CLIENT_SECRET, HEADER_SECRET, QUERY_SECRET, BODY_SECRET]) {
      expect(out).not.toContain(secret);
    }
  });

  test("the secret reads as the mask at the place it was stored", () => {
    const config = toPublicConnector(view({ config: secretBearingConfig() })).config as {
      oauth: Record<string, unknown>;
      static_headers: Record<string, unknown>;
      static_query: Record<string, unknown>;
    };
    expect(config.oauth.client_secret).toBe(CONNECTOR_SECRET_MASK);
    expect(config.static_headers.Authorization).toBe(CONNECTOR_SECRET_MASK);
    expect(config.static_headers["X-Api-Key"]).toBe(CONNECTOR_SECRET_MASK);
    expect(config.static_query.key).toBe(CONNECTOR_SECRET_MASK);
  });

  test.each([
    [
      "userinfo",
      `postgres://app_user:${DSN_SECRET}@db.acme.test:5432/app?sslmode=require`,
      `postgres://app_user:${CONNECTOR_SECRET_MASK}@db.acme.test:5432/app?sslmode=require`,
    ],
    [
      "userinfo with an unencoded @ in the password",
      `postgresql://app_user:p@${DSN_SECRET}@db.acme.test/app`,
      `postgresql://app_user:${CONNECTOR_SECRET_MASK}@db.acme.test/app`,
    ],
    [
      "query parameter",
      `postgres://db.acme.test/app?user=app_user&password=${DSN_SECRET}&sslmode=require`,
      `postgres://db.acme.test/app?user=app_user&password=${CONNECTOR_SECRET_MASK}&sslmode=require`,
    ],
    [
      "keyword form",
      `host=db.acme.test user=app_user password=${DSN_SECRET} dbname=app`,
      `host=db.acme.test user=app_user password=${CONNECTOR_SECRET_MASK} dbname=app`,
    ],
  ])("the dsn password is masked and nothing else is — %s", (_name, dsn, expected) => {
    const out = toPublicConnector(view({ driver: "postgres", dsn }));
    expect(out.dsn).toBe(expected);
    expect(out.dsn).not.toContain(DSN_SECRET);
  });

  test("a dsn without a password is returned as written", () => {
    const dsn = "postgres://app_user@db.acme.test:5432/app";
    expect(toPublicConnector(view({ driver: "postgres", dsn })).dsn).toBe(dsn);
  });
});

describe("toPublicConnector — what must stay readable", () => {
  test("endpoints, scopes, flags and credential hints come back deep-equal", () => {
    const config = toPublicConnector(view({ config: secretBearingConfig() })).config as {
      timeout_ms: unknown;
      credential_hints: unknown;
      oauth: Record<string, unknown>;
      static_headers: Record<string, unknown>;
      static_query: Record<string, unknown>;
    };
    const { client_secret, extra_token_headers, token_request_body_mapping, ...oauth } =
      config.oauth;
    expect(oauth).toEqual(NON_SECRET_OAUTH);
    expect(config.credential_hints).toEqual(CREDENTIAL_HINTS);
    expect(config.timeout_ms).toBe(5000);
    expect(config.static_headers.Accept).toBe("application/json");
    expect(config.static_headers["X-Api-Version"]).toBe("2024-01");
    expect(config.static_query.format).toBe("json");
    expect((extra_token_headers as Record<string, unknown>)["X-Tenant"]).toBe("acme");
  });

  test("an mcp auth block holds references, not secrets, and is returned as stored", () => {
    const config = {
      mcp: {
        transport: "http",
        auth: { kind: "bearer", token_ref: "vault:acme", credential_id: "cred-1" },
        tools_without_confirmation: ["search"],
      },
    };
    expect(toPublicConnector(view({ driver: "mcp", config })).config).toEqual(config);
  });

  test("the template snapshot passes through verbatim — recipe keys named like secrets hold references", () => {
    const template_snapshot = {
      slug: "acme",
      oauth: { issuer_url: "https://login.acme.test", token_endpoint: "https://login.acme.test/t" },
      recipes: [
        {
          workflow: {
            steps: [
              {
                headers: { Authorization: `Bearer \${scope.signin.idToken}` },
                body: { password: `\${input.password}` },
              },
            ],
          },
        },
      ],
    };
    expect(toPublicConnector(view({ template_snapshot })).template_snapshot).toEqual(
      template_snapshot,
    );
  });

  test("the view it was given is not modified — the server still reads the secret from it", () => {
    const original = view({
      config: secretBearingConfig(),
      dsn: `postgres://app_user:${DSN_SECRET}@db.acme.test/app`,
    });
    toPublicConnector(original);
    expect((original.config.oauth as Record<string, unknown>).client_secret).toBe(CLIENT_SECRET);
    expect(original.dsn).toContain(DSN_SECRET);
  });

  test("the execution-authority digest is taken over the stored view, and projecting does not move it", () => {
    // Grants are bound to this digest. It must keep hashing the real config
    // and dsn — a digest over the projection would be equal for two different
    // secrets, and switching to it would invalidate every grant issued so far.
    const original = view({
      config: secretBearingConfig(),
      dsn: `postgres://app_user:${DSN_SECRET}@db.acme.test/app`,
    });
    const before = authorityConnectorDigest(original);
    const projected = toPublicConnector(original);
    expect(authorityConnectorDigest(original)).toBe(before);
    expect(authorityConnectorDigest(projected)).not.toBe(before);
  });
});

describe("restoreMaskedConnectorSecrets — the mask means keep", () => {
  test("a config read through the projection and written back restores every secret", () => {
    const stored = { config: secretBearingConfig(), dsn: null };
    const readBack = toPublicConnector(view({ config: stored.config })).config;
    const edited = { ...readBack, timeout_ms: 9000 };
    const restored = restoreMaskedConnectorSecrets({ config: edited }, stored);
    expect(restored.config).toEqual({ ...secretBearingConfig(), timeout_ms: 9000 });
  });

  test("a real value sent in place of the mask replaces the stored secret", () => {
    const stored = { config: { oauth: { client_secret: CLIENT_SECRET } }, dsn: null };
    const restored = restoreMaskedConnectorSecrets(
      { config: { oauth: { client_secret: "fixture-rotated-not-real" } } },
      stored,
    );
    expect(restored.config).toEqual({ oauth: { client_secret: "fixture-rotated-not-real" } });
  });

  test("the masked dsn keeps the stored password while the rest of the string is taken as sent", () => {
    const stored = { config: {}, dsn: `postgres://app_user:${DSN_SECRET}@old.acme.test/app` };
    const restored = restoreMaskedConnectorSecrets(
      { dsn: `postgres://app_user:${CONNECTOR_SECRET_MASK}@new.acme.test:6432/app` },
      stored,
    );
    expect(restored.dsn).toBe(`postgres://app_user:${DSN_SECRET}@new.acme.test:6432/app`);
  });

  test("a kinded mask left by another scrubber is honoured the same way", () => {
    const stored = { config: { oauth: { client_secret: CLIENT_SECRET } }, dsn: null };
    const restored = restoreMaskedConnectorSecrets(
      { config: { oauth: { client_secret: "***REDACTED:key_value***" } } },
      stored,
    );
    expect(restored.config).toEqual({ oauth: { client_secret: CLIENT_SECRET } });
  });

  test("fields the caller did not send are not added", () => {
    const restored = restoreMaskedConnectorSecrets(
      { name: "Renamed" } as { name: string; config?: Record<string, unknown>; dsn?: string },
      { config: secretBearingConfig(), dsn: `postgres://u:${DSN_SECRET}@h/db` },
    );
    expect(restored).toEqual({ name: "Renamed" });
  });

  test("a mask with no stored secret behind it is refused, never stored", () => {
    const masked = { config: { oauth: { client_secret: CONNECTOR_SECRET_MASK } } };
    expect(() => restoreMaskedConnectorSecrets(masked, null)).toThrow(UnprocessableEntityError);
    expect(() =>
      restoreMaskedConnectorSecrets(masked, { config: { oauth: {} }, dsn: null }),
    ).toThrow("config.oauth.client_secret");
    expect(() =>
      restoreMaskedConnectorSecrets(
        { dsn: `postgres://u:${CONNECTOR_SECRET_MASK}@h/db` },
        { config: {}, dsn: "postgres://u@h/db" },
      ),
    ).toThrow(UnprocessableEntityError);
  });
});
