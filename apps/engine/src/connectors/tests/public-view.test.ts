import { describe, expect, test } from "bun:test";
import { UnprocessableEntityError } from "../../http/errors.ts";
import { FROZEN_NOW } from "../../test-helpers/determinism/clock.ts";
import { authorityConnectorDigest } from "../../workflows/authority-configuration.ts";
import {
  CONNECTOR_SECRET_MASK,
  connectorConfigPathCarriesSecret,
  restoreMaskedConnectorSecrets,
  type StoredConnectorSecrets,
  toPublicConnector,
} from "../public-view.ts";
import type { ConnectorView } from "../types.ts";

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

describe("toPublicConnector — a credential under a name nobody listed", () => {
  test.each([
    ["static_headers", "X-Auth"],
    ["static_headers", "X-Session-Id"],
    ["static_headers", "X-Signature"],
    ["default_headers", "X-Shop-Access"],
    ["static_query", "auth"],
    ["static_query", "sig"],
    ["static_query", "signature"],
    ["static_query", "pwd"],
    ["static_query", "jwt"],
    ["static_query", "appid"],
  ])("%s.%s is masked", (map, name) => {
    const config = toPublicConnector(view({ config: { [map]: { [name]: HEADER_SECRET } } }))
      .config as Record<string, Record<string, unknown>>;
    expect(config[map]?.[name]).toBe(CONNECTOR_SECRET_MASK);
  });

  test("a probe endpoint's headers are a name-keyed map too", () => {
    const config = toPublicConnector(
      view({
        config: {
          probe_endpoint: {
            method: "GET",
            path: "/me",
            headers: { "X-Session-Id": HEADER_SECRET, "Notion-Version": "2022-06-28" },
          },
        },
      }),
    ).config as { probe_endpoint: { path: string; headers: Record<string, unknown> } };
    expect(config.probe_endpoint.headers["X-Session-Id"]).toBe(CONNECTOR_SECRET_MASK);
    expect(config.probe_endpoint.headers["Notion-Version"]).toBe("2022-06-28");
    expect(config.probe_endpoint.path).toBe("/me");
  });

  test.each([
    "secret_access_key",
    "session_token",
    "passphrase",
    "webhook_secret",
    "clientSecret",
    "secretAccessKey",
  ])("the field %s is masked wherever the schema leaves room for it", (key) => {
    const config = toPublicConnector(
      view({ driver: "s3", config: { bucket: "reports", [key]: HEADER_SECRET } }),
    ).config as Record<string, unknown>;
    expect(config[key]).toBe(CONNECTOR_SECRET_MASK);
    expect(config.bucket).toBe("reports");
  });

  test("a base_url loses its userinfo password and its query credentials, and nothing else", () => {
    const out = toPublicConnector(
      view({
        base_url: `https://svc:${HEADER_SECRET}@api.acme.test/v2?api-version=7.0&sig=${QUERY_SECRET}`,
      }),
    );
    expect(out.base_url).toBe(
      `https://svc:${CONNECTOR_SECRET_MASK}@api.acme.test/v2?api-version=7.0&sig=${CONNECTOR_SECRET_MASK}`,
    );
  });

  test("a connection string quoted in a status text keeps its host and loses its password", () => {
    const text = `connect failed: postgres://app_user:${DSN_SECRET}@db.acme.test:5432/app timed out`;
    const out = toPublicConnector(
      view({ last_error: text, health_reason: text, auth_failed_reason: text }),
    );
    for (const shown of [out.last_error, out.health_reason, out.auth_failed_reason]) {
      expect(shown).toBe(
        `connect failed: postgres://app_user:${CONNECTOR_SECRET_MASK}@db.acme.test:5432/app timed out`,
      );
    }
  });
});

describe("connectorConfigPathCarriesSecret — the projection is the definition", () => {
  const config = secretBearingConfig();

  test.each([
    [["oauth", "client_secret"]],
    [["oauth"]],
    [["static_headers"]],
    [["static_headers", "X-Api-Key"]],
    [["oauth", "token_request_body_mapping", "client_id"]],
  ])("%j is, or contains, a secret", (path) => {
    expect(connectorConfigPathCarriesSecret(config, path)).toBe(true);
  });

  test.each([
    [["timeout_ms"]],
    [["oauth", "token_endpoint"]],
    [["static_headers", "Accept"]],
    [["credential_hints"]],
    [["does_not_exist"]],
  ])("%j is readable", (path) => {
    expect(connectorConfigPathCarriesSecret(config, path)).toBe(false);
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

function stored(overrides: Partial<StoredConnectorSecrets> = {}): StoredConnectorSecrets {
  return { base_url: "https://api.acme.test/v2", config: {}, dsn: null, ...overrides };
}

describe("restoreMaskedConnectorSecrets — the mask means keep", () => {
  test("a config read through the projection and written back restores every secret", () => {
    const config = secretBearingConfig();
    const readBack = toPublicConnector(view({ config })).config;
    const edited = { ...readBack, timeout_ms: 9000 };
    const restored = restoreMaskedConnectorSecrets({ config: edited }, stored({ config }));
    expect(restored.config).toEqual({ ...secretBearingConfig(), timeout_ms: 9000 });
  });

  test("a real value sent in place of the mask replaces the stored secret", () => {
    const restored = restoreMaskedConnectorSecrets(
      { config: { oauth: { client_secret: "fixture-rotated-not-real" } } },
      stored({ config: { oauth: { client_secret: CLIENT_SECRET } } }),
    );
    expect(restored.config).toEqual({ oauth: { client_secret: "fixture-rotated-not-real" } });
  });

  test("the masked dsn sent back unchanged keeps the stored password", () => {
    const dsn = `postgres://app_user:${DSN_SECRET}@db.acme.test/app?sslpassword=${QUERY_SECRET}`;
    const readBack = toPublicConnector(view({ driver: "postgres", dsn })).dsn as string;
    expect(restoreMaskedConnectorSecrets({ dsn: readBack }, stored({ dsn })).dsn).toBe(dsn);
  });

  test("a masked base_url sent back unchanged keeps what it carried", () => {
    const base_url = `https://svc:${HEADER_SECRET}@api.acme.test/v2?sig=${QUERY_SECRET}`;
    const readBack = toPublicConnector(view({ base_url })).base_url;
    const restored = restoreMaskedConnectorSecrets({ base_url: readBack }, stored({ base_url }));
    expect(restored.base_url).toBe(base_url);
  });

  test("a kinded mask left by another scrubber is honoured the same way", () => {
    const restored = restoreMaskedConnectorSecrets(
      { config: { oauth: { client_secret: "***REDACTED:key_value***" } } },
      stored({ config: { oauth: { client_secret: CLIENT_SECRET } } }),
    );
    expect(restored.config).toEqual({ oauth: { client_secret: CLIENT_SECRET } });
  });

  test("fields the caller did not send are not added", () => {
    const restored = restoreMaskedConnectorSecrets(
      { name: "Renamed" } as { name: string; config?: Record<string, unknown>; dsn?: string },
      stored({ config: secretBearingConfig(), dsn: `postgres://u:${DSN_SECRET}@h/db` }),
    );
    expect(restored).toEqual({ name: "Renamed" });
  });

  test("a mask with no stored secret behind it is refused, never stored", () => {
    const masked = { config: { oauth: { client_secret: CONNECTOR_SECRET_MASK } } };
    expect(() => restoreMaskedConnectorSecrets(masked, null)).toThrow(UnprocessableEntityError);
    expect(() => restoreMaskedConnectorSecrets(masked, stored({ config: { oauth: {} } }))).toThrow(
      "config.oauth.client_secret",
    );
    expect(() =>
      restoreMaskedConnectorSecrets(
        { dsn: `postgres://u:${CONNECTOR_SECRET_MASK}@h/db` },
        stored({ dsn: "postgres://u@h/db" }),
      ),
    ).toThrow(UnprocessableEntityError);
  });

  test("a value that merely contains the mask is refused, never stored or sent", () => {
    const at = stored({ config: { static_headers: { Authorization: `Bearer ${HEADER_SECRET}` } } });
    expect(() =>
      restoreMaskedConnectorSecrets(
        { config: { static_headers: { Authorization: `Bearer ${CONNECTOR_SECRET_MASK}` } } },
        at,
      ),
    ).toThrow("config.static_headers.Authorization contains the redaction mask");
    expect(() =>
      restoreMaskedConnectorSecrets(
        { base_url: `https://api.acme.test/${CONNECTOR_SECRET_MASK}/v2` },
        at,
      ),
    ).toThrow(UnprocessableEntityError);
  });
});

describe("restoreMaskedConnectorSecrets — a kept secret does not follow a changed destination", () => {
  const DSN = `postgres://app_user:${DSN_SECRET}@db.acme.test:5432/app`;

  test.each([
    ["another host", `postgres://app_user:${CONNECTOR_SECRET_MASK}@other.acme.test:5432/app`],
    ["another port", `postgres://app_user:${CONNECTOR_SECRET_MASK}@db.acme.test:6432/app`],
    ["another user", `postgres://someone:${CONNECTOR_SECRET_MASK}@db.acme.test:5432/app`],
    ["another database", `postgres://app_user:${CONNECTOR_SECRET_MASK}@db.acme.test:5432/other`],
  ])("a masked dsn pointing at %s is refused", (_name, dsn) => {
    expect(() => restoreMaskedConnectorSecrets({ dsn }, stored({ dsn: DSN }))).toThrow(
      UnprocessableEntityError,
    );
  });

  test("the same dsn with the real password moves freely", () => {
    const dsn = `postgres://app_user:${DSN_SECRET}@other.acme.test:5432/app`;
    expect(restoreMaskedConnectorSecrets({ dsn }, stored({ dsn: DSN })).dsn).toBe(dsn);
  });

  const OAUTH = {
    issuer_url: "https://login.acme.test",
    token_endpoint: "https://login.acme.test/token",
    client_id: "acme-client-id",
    client_secret: CLIENT_SECRET,
    token_request_body_mapping: { client_secret: BODY_SECRET },
  };
  const MASKED_OAUTH = {
    ...OAUTH,
    client_secret: CONNECTOR_SECRET_MASK,
    token_request_body_mapping: { client_secret: CONNECTOR_SECRET_MASK },
  };

  test.each([
    ["token_endpoint", { token_endpoint: "https://login.other.test/token" }],
    ["issuer_url", { issuer_url: "https://login.other.test" }],
  ])("a masked client secret with a changed %s is refused", (key, change) => {
    expect(() =>
      restoreMaskedConnectorSecrets(
        { config: { oauth: { ...MASKED_OAUTH, ...change } } },
        stored({ config: { oauth: OAUTH } }),
      ),
    ).toThrow(`config.oauth.${key} changed`);
  });

  test("a masked token body value is held to the token endpoint as well", () => {
    expect(() =>
      restoreMaskedConnectorSecrets(
        {
          config: {
            oauth: {
              ...OAUTH,
              token_endpoint: "https://login.other.test/token",
              token_request_body_mapping: { client_secret: CONNECTOR_SECRET_MASK },
            },
          },
        },
        stored({ config: { oauth: OAUTH } }),
      ),
    ).toThrow("config.oauth.token_request_body_mapping.client_secret");
  });

  test("a masked client secret is refused when the write binds another template", () => {
    expect(() =>
      restoreMaskedConnectorSecrets(
        { config: { oauth: MASKED_OAUTH } },
        stored({ config: { oauth: OAUTH } }),
        { template_rebound: true },
      ),
    ).toThrow("the connector's template changed");
  });

  test("a changed base_url leaves the OAuth client secret where it is — it goes to the token endpoint", () => {
    const restored = restoreMaskedConnectorSecrets(
      { base_url: "https://api.other.test/v2", config: { oauth: MASKED_OAUTH } },
      stored({ config: { oauth: OAUTH } }),
    );
    expect(restored.config).toEqual({ oauth: OAUTH });
  });

  const HEADERS = { static_headers: { "X-Session-Id": HEADER_SECRET } };
  const MASKED_HEADERS = { static_headers: { "X-Session-Id": CONNECTOR_SECRET_MASK } };

  test.each([
    ["another host", "https://api.other.test/v2"],
    ["another path", "https://api.acme.test/elsewhere"],
    ["another scheme", "http://api.acme.test/v2"],
  ])("a masked header with a base_url on %s is refused", (_name, base_url) => {
    expect(() =>
      restoreMaskedConnectorSecrets(
        { base_url, config: MASKED_HEADERS },
        stored({ config: HEADERS }),
      ),
    ).toThrow(
      "config.static_headers.X-Session-Id carries the redaction mask, but base_url changed",
    );
  });

  test("a masked header is kept when base_url is not sent, or sent as stored", () => {
    for (const base_url of [undefined, "https://api.acme.test/v2", "https://api.acme.test/v2/"]) {
      const restored = restoreMaskedConnectorSecrets(
        { ...(base_url ? { base_url } : {}), config: MASKED_HEADERS },
        stored({ config: HEADERS }),
      );
      expect(restored.config).toEqual(HEADERS);
    }
  });

  test("a masked base_url on another host is refused", () => {
    expect(() =>
      restoreMaskedConnectorSecrets(
        { base_url: `https://svc:${CONNECTOR_SECRET_MASK}@api.other.test/v2` },
        stored({ base_url: `https://svc:${HEADER_SECRET}@api.acme.test/v2` }),
      ),
    ).toThrow(UnprocessableEntityError);
  });

  test("a masked field of an object-store config is held to its endpoint", () => {
    const at = stored({
      base_url: null,
      config: { bucket: "reports", endpoint: "https://store.acme.test", passphrase: HEADER_SECRET },
    });
    expect(() =>
      restoreMaskedConnectorSecrets(
        {
          config: {
            bucket: "reports",
            endpoint: "https://store.other.test",
            passphrase: CONNECTOR_SECRET_MASK,
          },
        },
        at,
      ),
    ).toThrow("config.endpoint changed");
  });
});
