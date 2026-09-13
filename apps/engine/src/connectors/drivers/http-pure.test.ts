// Pure-function tests for the HTTP driver's URL resolution, header
// validation, applied-auth-method derivation, and probe-status
// classification. No DB, no network, no Docker.

import { describe, expect, test } from "bun:test";

import type { ConnectorView } from "../types.ts";
import {
  classifyHttpProbeStatus,
  deriveAppliedAuthMethod,
  HttpRequestInvalidError,
  resolveUrl,
  validateOutboundHeaders,
} from "./http.ts";

function makeConnector(overrides: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: "00000000-0000-0000-0000-0000000000c1",
    tenant_id: "tenant-http-pure",
    slug: "http-pure-test",
    driver: "http",
    environment: "dev",
    auth_type: "none",
    base_url: "https://api.example.test",
    config: {},
    template_slug: null,
    template_snapshot: null,
    ...overrides,
  } as unknown as ConnectorView;
}

describe("resolveUrl — additional edge cases", () => {
  test("empty base_url with an absolute path uses the absolute URL directly", () => {
    expect(resolveUrl("", "https://other.example.com/x").href).toBe("https://other.example.com/x");
  });

  test("empty base_url with a relative path throws a descriptive error", () => {
    expect(() => resolveUrl("", "/x")).toThrow(/no base_url/);
  });

  test("query string on the path is preserved through URL construction", () => {
    const url = resolveUrl("https://api.example.com/v1", "search?q=foo&limit=5");
    expect(url.pathname).toBe("/v1/search");
    expect(url.searchParams.get("q")).toBe("foo");
    expect(url.searchParams.get("limit")).toBe("5");
  });

  test("base with root pathname and no leading slash on path resolves at the origin", () => {
    const url = resolveUrl("https://api.example.com/", "users");
    expect(url.href).toBe("https://api.example.com/users");
  });
});

describe("validateOutboundHeaders", () => {
  test("a plain string-keyed record passes without throwing", () => {
    expect(() => validateOutboundHeaders({ "X-Trace-Id": "abc123" })).not.toThrow();
  });

  test("an empty object passes", () => {
    expect(() => validateOutboundHeaders({})).not.toThrow();
  });

  test("null throws HttpRequestInvalidError", () => {
    expect(() => validateOutboundHeaders(null)).toThrow(HttpRequestInvalidError);
  });

  test("a non-object (string) throws HttpRequestInvalidError", () => {
    expect(() => validateOutboundHeaders("not-an-object")).toThrow(HttpRequestInvalidError);
  });

  test("an array throws HttpRequestInvalidError with the array label", () => {
    try {
      validateOutboundHeaders(["a", "b"]);
      throw new Error("expected validateOutboundHeaders to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpRequestInvalidError);
      expect((err as Error).message).toContain("array");
    }
  });

  test("a header name that isn't an RFC 7230 token throws", () => {
    expect(() => validateOutboundHeaders({ '{"Accept"': "x" })).toThrow(HttpRequestInvalidError);
  });

  test("a non-string header value throws", () => {
    expect(() => validateOutboundHeaders({ "X-Count": 5 })).toThrow(HttpRequestInvalidError);
  });
});

describe("deriveAppliedAuthMethod", () => {
  test("null credential → none", () => {
    expect(deriveAppliedAuthMethod(null, false)).toBe("none");
  });

  test("none-mode credential → none", () => {
    expect(deriveAppliedAuthMethod({ mode: "none" }, false)).toBe("none");
  });

  test("bearer → bearer", () => {
    expect(deriveAppliedAuthMethod({ mode: "bearer", token: "t" }, false)).toBe("bearer");
  });

  test("header → header", () => {
    expect(deriveAppliedAuthMethod({ mode: "header", headers: {} }, false)).toBe("header");
  });

  test("query → query", () => {
    expect(deriveAppliedAuthMethod({ mode: "query", query: {} }, false)).toBe("query");
  });

  test("basic → basic", () => {
    expect(deriveAppliedAuthMethod({ mode: "basic", username: "u", password: "p" }, false)).toBe(
      "basic",
    );
  });

  test("aws_sigv4 → aws_sigv4", () => {
    expect(
      deriveAppliedAuthMethod(
        { mode: "aws_sigv4", access_key_id: "a", secret_access_key: "s" },
        false,
      ),
    ).toBe("aws_sigv4");
  });

  test("oauth2 not refreshed → oauth2_static", () => {
    expect(
      deriveAppliedAuthMethod(
        {
          mode: "oauth2",
          access_token: "tok",
          token_type: "Bearer",
          refresh_token: null,
          expires_at: null,
        },
        false,
      ),
    ).toBe("oauth2_static");
  });

  test("oauth2 refreshed → oauth2_refreshed", () => {
    expect(
      deriveAppliedAuthMethod(
        {
          mode: "oauth2",
          access_token: "tok",
          token_type: "Bearer",
          refresh_token: null,
          expires_at: null,
        },
        true,
      ),
    ).toBe("oauth2_refreshed");
  });

  function tokenMintCredential(access_token: string) {
    return {
      mode: "token_mint" as const,
      access_token,
      refresh_token: null,
      expires_at: null,
      shape: "json" as const,
      mint_endpoint: "https://idp.example.test/login",
      credentials: { username: "u", password: "p" },
      token_path: "access_token",
    };
  }

  test("token_mint not refreshed → token_mint_static", () => {
    expect(deriveAppliedAuthMethod(tokenMintCredential("tok"), false)).toBe("token_mint_static");
  });

  test("token_mint refreshed → token_mint_refreshed", () => {
    expect(deriveAppliedAuthMethod(tokenMintCredential("tok"), true)).toBe("token_mint_refreshed");
  });

  test("oauth2_client → none (not directly appliable)", () => {
    expect(
      deriveAppliedAuthMethod({ mode: "oauth2_client", client_id: "c", client_secret: "s" }, false),
    ).toBe("none");
  });

  test("oauth2_private_key → none (not directly appliable)", () => {
    expect(
      deriveAppliedAuthMethod(
        { mode: "oauth2_private_key", client_id: "c", private_key: "k", algorithm: "RS256" },
        false,
      ),
    ).toBe("none");
  });
});

describe("classifyHttpProbeStatus — status-only buckets", () => {
  test("401 → credential_invalid", () => {
    expect(classifyHttpProbeStatus(401, makeConnector()).code).toBe("credential_invalid");
  });

  test("403 without a body → scope_insufficient", () => {
    expect(classifyHttpProbeStatus(403, makeConnector()).code).toBe("scope_insufficient");
  });

  test("404 → remote_resource_not_found", () => {
    expect(classifyHttpProbeStatus(404, makeConnector()).code).toBe("remote_resource_not_found");
  });

  test("500 → unknown_upstream_error", () => {
    expect(classifyHttpProbeStatus(500, makeConnector()).code).toBe("unknown_upstream_error");
  });

  test("400 → unknown_upstream_error", () => {
    expect(classifyHttpProbeStatus(400, makeConnector()).code).toBe("unknown_upstream_error");
  });
});

describe("classifyHttpProbeStatus — Google accessNotConfigured body upgrade", () => {
  const accessNotConfiguredBody = {
    error: {
      message: "Access Not Configured. Drive API has not been used in project 123 before.",
      errors: [{ reason: "accessNotConfigured" }],
    },
  };

  test("403 + accessNotConfigured body upgrades to remote_api_disabled with a deep link", () => {
    const connector = makeConnector({ base_url: "https://www.googleapis.com/drive/v3" });
    const result = classifyHttpProbeStatus(403, connector, accessNotConfiguredBody);
    expect(result.code).toBe("remote_api_disabled");
    expect(result.provider_action_url).toBe(
      "https://console.cloud.google.com/apis/library/drive.googleapis.com",
    );
  });

  test("404 + accessNotConfigured body also upgrades (older Google APIs return 404)", () => {
    const result = classifyHttpProbeStatus(404, makeConnector(), accessNotConfiguredBody);
    expect(result.code).toBe("remote_api_disabled");
  });

  test("403 + unrelated body falls back to scope_insufficient", () => {
    const result = classifyHttpProbeStatus(403, makeConnector(), { error: "nope" });
    expect(result.code).toBe("scope_insufficient");
  });

  test("403 + accessNotConfigured body with no extractable api_name and a non-googleapis base_url has no deep link", () => {
    // Message has no "<Name> API" phrase to extract api_name from, and the
    // base_url isn't a googleapis.com host either — neither deep-link source
    // resolves, so provider_action_url stays unset.
    const connector = makeConnector({ base_url: "https://api.internal-service.test" });
    const result = classifyHttpProbeStatus(403, connector, {
      error: {
        message: "Access is not configured for this project.",
        errors: [{ reason: "accessNotConfigured" }],
      },
    });
    expect(result.code).toBe("remote_api_disabled");
    expect(result.provider_action_url).toBeUndefined();
  });

  test("403 + body without an errors array is not upgraded", () => {
    const result = classifyHttpProbeStatus(403, makeConnector(), { error: { message: "x" } });
    expect(result.code).toBe("scope_insufficient");
  });
});
